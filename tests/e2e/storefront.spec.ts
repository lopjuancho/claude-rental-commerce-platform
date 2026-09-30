import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

/**
 * M6 storefront (ADR 0016) against the seeded fictional tenants (supabase/seed.sql): `acme` at
 * acme.localhost and `funtime` at funtime.localhost. Chromium resolves *.localhost to loopback,
 * so each host is its own tenant exactly like production custom domains.
 * Needs the Supabase stack (REST + seed): enabled with E2E_TENANTS=1 (CI).
 */
test.skip(process.env.E2E_TENANTS !== "1", "needs the seeded Supabase stack (E2E_TENANTS=1)");

const port = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000").port || "3000";
const ACME = `http://acme.localhost:${port}`;
const FUNTIME = `http://funtime.localhost:${port}`;
const ACME_ID = "10000000-0000-4000-8000-000000000001";
const STALE = "Your event details changed, so we need to recalculate availability and pricing.";

async function jsonLd(page: Page): Promise<Record<string, unknown>[]> {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  return blocks.flatMap((b) => {
    const parsed = JSON.parse(b) as Record<string, unknown> | Record<string, unknown>[];
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

async function expectA11yBasics(page: Page) {
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();
  // Every image has alt text; every visible form control has an accessible name.
  expect(await page.locator("img:not([alt]), img[alt='']").count()).toBe(0);
  const unnamed = await page
    .locator("input:not([type=hidden]), select, textarea")
    .evaluateAll((els) =>
      els
        .filter((el) => {
          const e = el as HTMLInputElement;
          const labelled =
            (e.labels && e.labels.length > 0) ||
            e.getAttribute("aria-label") ||
            e.getAttribute("aria-labelledby");
          return !labelled;
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
  expect(unnamed).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("tenant isolation", () => {
  test("each host renders only its own tenant's catalog", async ({ page }) => {
    await page.goto(`${ACME}/rentals`);
    await expect(page.getByRole("heading", { level: 1, name: "All rentals" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Sample Castle/ }).first()).toBeVisible();
    await expect(page.getByText("FunTime Popcorn Machine")).toHaveCount(0);

    await page.goto(`${FUNTIME}/rentals`);
    await expect(page.getByRole("link", { name: /FunTime Popcorn Machine/ }).first()).toBeVisible();
    await expect(page.getByText("Sample Castle")).toHaveCount(0);
    await expect(page.getByText("Acme Party Rentals")).toHaveCount(0);
  });

  test("another tenant's product or category is a 404 on this host", async ({ page }) => {
    expect((await page.goto(`${ACME}/rentals/popcorn-machine`))?.status()).toBe(404);
    expect((await page.goto(`${ACME}/categories/concessions`))?.status()).toBe(404);
    expect((await page.goto(`${FUNTIME}/rentals/sample-castle`))?.status()).toBe(404);
    await expect(page.getByText("Sample Castle")).toHaveCount(0);
  });

  test("unpublished products and categories are hidden and 404", async ({ page }) => {
    expect((await page.goto(`${ACME}/rentals/unreleased-obstacle-course`))?.status()).toBe(404);
    expect((await page.goto(`${ACME}/categories/coming-soon`))?.status()).toBe(404);
    await page.goto(`${ACME}/rentals`);
    await expect(page.getByText("Unreleased Obstacle Course")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Coming Soon" })).toHaveCount(0);
  });
});

test.describe("pages, metadata and structured data", () => {
  test("home: tenant branding, canonical, LocalBusiness from configured data only", async ({
    page,
  }) => {
    await page.goto(`${ACME}/`);
    await expect(page).toHaveTitle("Acme Party Rentals — Event rentals");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${ACME}/`);
    // Not a production host: never indexable.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const brand = await page
      .locator("[style*='--brand']")
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--brand").trim());
    expect(brand.toLowerCase()).toBe("#2563eb");
    const [business] = (await jsonLd(page)).filter((d) => d["@type"] === "LocalBusiness");
    expect(business).toMatchObject({ name: "Acme Party Rentals", telephone: "+15555550100" });
    const raw = JSON.stringify(await jsonLd(page));
    expect(raw).not.toMatch(/aggregateRating|review|availability/i);
    await expect(page.getByRole("heading", { name: "Popular rentals" })).toBeVisible();
    await expectA11yBasics(page);
  });

  test("category page lists its published products with breadcrumbs", async ({ page }) => {
    await page.goto(`${ACME}/categories/bounce-houses`);
    await expect(page.getByRole("heading", { level: 1, name: "Bounce Houses" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Sample Castle/ }).first()).toBeVisible();
    await expect(page).toHaveTitle("Bounce Houses rentals | Acme Party Rentals");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Rentals");
    const crumbs = (await jsonLd(page)).find((d) => d["@type"] === "BreadcrumbList");
    expect(JSON.stringify(crumbs)).toContain(`${ACME}/categories/bounce-houses`);
    await expectA11yBasics(page);
  });

  test("product page: correct metadata, authoritative Offer only, configured specs", async ({
    page,
  }) => {
    await page.goto(`${ACME}/rentals/sample-castle`);
    await expect(page).toHaveTitle("Sample Castle rental | Acme Party Rentals");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${ACME}/rentals/sample-castle`,
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "Sample Castle rental | Acme Party Rentals",
    );
    const product = (await jsonLd(page)).find((d) => d["@type"] === "Product");
    expect(product).toMatchObject({
      name: "Sample Castle",
      offers: { "@type": "Offer", price: "175.00", priceCurrency: "USD" },
    });
    expect(JSON.stringify(product)).not.toMatch(/availability|aggregateRating|review/i);
    await expect(page.getByText("$175", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText(/Delivery, tax and options are calculated in your quote/),
    ).toBeVisible();
    await expect(page.getByText("3–10 years")).toBeVisible(); // configured ages
    await expect(page.getByText(/may not operate in wind over 20 mph/)).toBeVisible();
    await expectA11yBasics(page);
  });

  test("robots and sitemap never expose a non-production host", async ({ page }) => {
    await page.goto(`${ACME}/robots.txt`);
    expect(await page.locator("body").innerText()).toMatch(/Disallow: \/\s*$/m);
    await page.goto(`${ACME}/sitemap.xml`);
    expect(await page.content()).not.toContain("sample-castle");
  });
});

test.describe("quote flow", () => {
  test("the product CTA carries the product into the quote form", async ({ page }) => {
    await page.goto(`${ACME}/rentals/sample-castle`);
    await page.getByRole("link", { name: "Check availability & get a quote" }).first().click();
    await expect(page).toHaveURL(`${ACME}/quote?item=sample-castle`);
    await expect(page.getByLabel("Item 1", { exact: true })).toHaveValue(/.+/);
    await expect(page.getByLabel("Item 1", { exact: true }).locator("option:checked")).toHaveText(
      "Sample Castle",
    );
    await expectA11yBasics(page);
    // Add and remove rows; quantities step within bounds.
    await page.getByRole("button", { name: "+ Add another rental" }).click();
    await expect(page.getByLabel("Item 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove item 2" }).click();
    await expect(page.getByLabel("Item 2", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page.locator('input[name="quantity0"]')).toHaveValue("2");
  });

  test("a stale quote asks to recalculate instead of offering Request booking", async ({
    page,
  }) => {
    test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL to change the event");
    const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
    const date = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    await page.goto(`${ACME}/quote?item=sample-castle`);
    await page.getByLabel("Date", { exact: true }).fill(date);
    await page.getByLabel("I will pick up").check();
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("button", { name: "Get my quote" }).click();
    await expect(page).toHaveURL(/\/q\/[A-Za-z0-9_-]{43}$/, { timeout: 20_000 });
    await expect(page.getByText(STALE)).toHaveCount(0);
    const quoteUrl = page.url();
    const token = quoteUrl.split("/q/")[1]!;

    // Staff change the event after pricing (as an admin script would: organization gate first).
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      await db.query("begin");
      await db.query("select app.acquire_org_gates($1::uuid[])", [[ACME_ID]]);
      await db.query(
        `update public.events set end_time = end_time + interval '1 hour'
         where id = (select q.event_id from public.quotes q join public.customers c on c.id = q.customer_id
                     where q.organization_id = $1 and c.email = $2)`,
        [ACME_ID, email],
      );
      await db.query("commit");
    } finally {
      await db.end();
    }

    await page.reload();
    await expect(page.getByText(STALE)).toBeVisible();
    await expect(page.getByRole("button", { name: /Request this booking/ })).toHaveCount(0);
    await page.getByRole("link", { name: "Update my quote" }).click();
    await expect(page).toHaveURL(`${ACME}/quote?from=${token}`);
    await expect(page.getByRole("heading", { level: 1, name: "Update your quote" })).toBeVisible();
    await expect(page.getByLabel("Item 1", { exact: true }).locator("option:checked")).toHaveText(
      "Sample Castle",
    );
    await expect(page.getByLabel("Date", { exact: true })).toHaveValue(date);
  });
});

test.describe("mobile critical flows", () => {
  test("home → category → product → quote works without horizontal scroll", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "mobile project only");
    await page.goto(`${ACME}/`);
    await expectNoHorizontalScroll(page);
    await page
      .getByRole("navigation", { name: "Browse categories" })
      .getByRole("link", { name: "Bounce Houses" })
      .click();
    await expect(page).toHaveURL(`${ACME}/categories/bounce-houses`);
    await expectNoHorizontalScroll(page);
    await page
      .getByRole("link", { name: /Sample Castle/ })
      .first()
      .click();
    await expect(page).toHaveURL(`${ACME}/rentals/sample-castle`);
    await expectNoHorizontalScroll(page);
    // The sticky bar keeps the quote CTA in reach on small screens.
    const sticky = page.getByTestId("sticky-cta").getByRole("link", { name: "Get a quote" });
    await expect(sticky).toBeInViewport();
    await sticky.click();
    await expect(page).toHaveURL(`${ACME}/quote?item=sample-castle`);
    await expectNoHorizontalScroll(page);
    const box = await page.getByRole("button", { name: "Get my quote" }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44); // comfortable touch target
  });
});
