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

test.describe("M1: search indexing follows the verified request host", () => {
  // Development build: nothing is indexable; what differs per host is canonical and follow.
  // Production behavior (index,follow only on the verified canonical host) is unit-tested in
  // tests/unit/storefront-domain.test.ts with production inputs.
  const robots = (page: Page) => page.locator('meta[name="robots"]').getAttribute("content");
  const canonical = (page: Page) => page.locator('link[rel="canonical"]').getAttribute("href");

  test("verified primary: canonical on itself", async ({ page }) => {
    await page.goto(`${ACME}/rentals/sample-castle`);
    expect(await robots(page)).toBe("noindex, follow");
    expect(await canonical(page)).toBe(`${ACME}/rentals/sample-castle`);
  });

  test("verified alias: noindex,follow and canonical on the primary", async ({ page }) => {
    await page.goto(`http://www.acme.localhost:${port}/rentals/sample-castle`);
    expect(await robots(page)).toBe("noindex, follow");
    expect(await canonical(page)).toBe(`${ACME}/rentals/sample-castle`);
  });

  test("unverified host: noindex,nofollow, never canonical, closed robots, empty sitemap", async ({
    page,
  }) => {
    const UNVERIFIED = `http://unverified.acme.localhost:${port}`;
    await page.goto(`${UNVERIFIED}/rentals/sample-castle`);
    expect(await robots(page)).toBe("noindex, nofollow");
    expect(await canonical(page)).toBe(`${ACME}/rentals/sample-castle`);
    const ld = JSON.stringify(await jsonLd(page));
    expect(ld).not.toContain("unverified.acme.localhost");
    await page.goto(`${UNVERIFIED}/robots.txt`);
    expect(await page.locator("body").innerText()).toMatch(/Disallow: \/\s*$/m);
    await page.goto(`${UNVERIFIED}/sitemap.xml`);
    expect(await page.content()).not.toContain("<loc>");
  });
});

test.describe("M2: advertised prices match what a quote starts from", () => {
  test("variants with different prices show 'From' the lowest and no structured Offer", async ({
    page,
  }) => {
    await page.goto(`${ACME}/categories/tables-and-chairs`);
    const card = page.getByRole("article").filter({ hasText: "Party Tent" });
    await expect(card).toContainText("From $300 per event");
    await expect(card).not.toContainText("$250"); // the product base is never what a quote charges
    await page.goto(`${ACME}/rentals/party-tent`);
    await expect(page.getByText("$300", { exact: true }).first()).toBeVisible();
    const product = (await jsonLd(page)).find((d) => d["@type"] === "Product");
    expect(product).toBeDefined();
    expect(product).not.toHaveProperty("offers");
  });

  test("every card uses the same price qualification", async ({ page }) => {
    await page.goto(`${ACME}/rentals`);
    const prices = page.getByRole("article").locator("p", { hasText: /\$\d/ });
    const texts = await prices.allInnerTexts();
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).toMatch(/^From \$/);
  });
});

test.describe("M3: token-prefilled quote forms are private", () => {
  const meta = async (page: Page) => ({
    robots: await page.locator('meta[name="robots"]').getAttribute("content"),
    canonical: await page.locator('link[rel="canonical"]').getAttribute("href"),
  });

  test("blank form keeps normal metadata; any ?from= is noindex,nofollow without the token", async ({
    page,
  }) => {
    await page.goto(`${ACME}/quote`);
    expect(await meta(page)).toEqual({ robots: "noindex, follow", canonical: `${ACME}/quote` });
    for (const from of ["A".repeat(43), "not-a-token", ""]) {
      await page.goto(`${ACME}/quote?from=${from}`);
      const m = await meta(page);
      expect(m).toEqual({ robots: "noindex, nofollow", canonical: `${ACME}/quote` });
    }
  });
});

test.describe("keyboard", () => {
  test("skip link moves focus to the main content", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard navigation (desktop)");
    await page.goto(`${ACME}/rentals/sample-castle`);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
  });

  test("quote items are operable from the keyboard", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard navigation (desktop)");
    await page.goto(`${ACME}/quote?item=sample-castle`);
    await page.getByLabel("Item 1", { exact: true }).focus();
    await page.keyboard.press("Tab"); // decrease is disabled at 1 → quantity field
    await expect(page.locator('input[name="quantity0"]')).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Increase quantity" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('input[name="quantity0"]')).toHaveValue("2");
    await page.getByRole("button", { name: "+ Add another rental" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Item 2", { exact: true })).toBeVisible();
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
    // The quote itself renders right after submitting (not a 404 until reload).
    await expect(page.getByRole("heading", { level: 1, name: /^Quote Q-/ })).toBeVisible();
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
    // The prefilled form is private and never canonicalizes the token (as a crawler loads it).
    await page.goto(`${ACME}/quote?from=${token}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${ACME}/quote`);

    // Recalculation completes: the earlier fulfilment (pickup) is kept, a new quote is priced
    // from scratch for the event as it is now, and it is not stale.
    await expect(page.getByLabel("I will pick up")).toBeChecked();
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("button", { name: "Get my quote" }).click();
    await expect(page).toHaveURL(/\/q\/[A-Za-z0-9_-]{43}$/, { timeout: 20_000 });
    expect(page.url()).not.toContain(token);
    await expect(page.getByRole("heading", { level: 1, name: /^Quote Q-/ })).toBeVisible();
    await expect(page.getByText(STALE)).toHaveCount(0);
    await expect(page.getByText("Sample Castle").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Update my quote" })).toHaveCount(0);
  });
});

test.describe("/media/[id] HTTP responses", () => {
  // Needs Supabase Storage (the CI stack): objects are uploaded with the service key here, as
  // an admin upload would, and read back through the storefront route with the anon client.
  test.skip(process.env.E2E_STORAGE !== "1", "needs Supabase Storage (E2E_STORAGE=1)");
  test.describe.configure({ mode: "serial" });

  const FUNTIME_ID = "20000000-0000-4000-8000-000000000001";
  const CASTLE = "12000000-0000-4000-8000-000000000001";
  const UNRELEASED = "12000000-0000-4000-8000-000000000004";
  const POPCORN = "22000000-0000-4000-8000-000000000001";
  // 1×1 transparent PNG.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const ids = {} as Record<"ok" | "unverified" | "unpublished" | "otherTenant", string>;
  const media = (id: string, host: string, query = "") =>
    ({ url: `http://localhost:${port}/media/${id}${query}`, host: `${host}:${port}` }) as const;

  test.beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const storage = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    ).storage.from("product-media");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const add = async (org: string, product: string, rights: string) => {
        const path = `${org}/e2e-${randomUUID()}.png`;
        const up = await storage.upload(path, PNG, { contentType: "image/png" });
        if (up.error) throw up.error;
        await db.query("begin");
        await db.query("select app.acquire_org_gates($1::uuid[])", [[org]]);
        const r = await db.query<{ id: string }>(
          `insert into public.product_media (organization_id, product_id, storage_path, source, rights_status, alt_text, sort_order)
           values ($1, $2, $3, 'upload', $4, 'E2E photo', 1000) returning id`,
          [org, product, path, rights],
        );
        await db.query("commit");
        return r.rows[0]!.id;
      };
      ids.ok = await add(ACME_ID, CASTLE, "owned");
      ids.unverified = await add(ACME_ID, CASTLE, "unverified");
      ids.unpublished = await add(ACME_ID, UNRELEASED, "owned");
      ids.otherTenant = await add(FUNTIME_ID, POPCORN, "owned");
    } finally {
      await db.end();
    }
  });

  test("the host's published, rights-verified image is served with safe, cacheable headers", async ({
    request,
  }) => {
    const m = media(ids.ok, "acme.localhost");
    const res = await request.get(m.url, { headers: { host: m.host } });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(res.headers()["cache-control"]).toBe(
      "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
    );
    expect(res.headers()["vary"]).toMatch(/Host/i);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(await res.body()).equals(PNG)).toBe(true);
    // Allowed derivative widths only (originals while transformations are off).
    expect((await request.get(`${m.url}?w=640`, { headers: { host: m.host } })).status()).toBe(200);
  });

  test("everything else is a non-cacheable 404", async ({ request }) => {
    const cases = [
      media(ids.otherTenant, "acme.localhost"), // another tenant's media on this host
      media(ids.unverified, "acme.localhost"), // rights not verified
      media(ids.unpublished, "acme.localhost"), // unpublished product
      media(randomUUID(), "acme.localhost"), // unknown id
      media("not-a-uuid", "acme.localhost"),
      media(ids.ok, "acme.localhost", "?w=999"), // arbitrary size
      media(ids.ok, "localhost"), // no tenant
    ];
    for (const c of cases) {
      const res = await request.get(c.url, { headers: { host: c.host } });
      expect(res.status(), c.url).toBe(404);
      expect(res.headers()["cache-control"]).toBe("no-store");
    }
    // The other tenant's image does exist — on its own host.
    const own = media(ids.otherTenant, "funtime.localhost");
    expect((await request.get(own.url, { headers: { host: own.host } })).status()).toBe(200);
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
