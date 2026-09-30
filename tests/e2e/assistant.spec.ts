import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

/**
 * M7 storefront assistant (ADR 0017) on the seeded tenants, with the scripted test-double model
 * (AI_PROVIDER=scripted): every tool call runs the real backend, and the database is checked
 * against what the assistant said. Needs the Supabase stack (E2E_TENANTS=1).
 */
test.skip(process.env.E2E_TENANTS !== "1", "needs the seeded Supabase stack (E2E_TENANTS=1)");
test.skip(process.env.AI_PROVIDER !== "scripted", "needs AI_PROVIDER=scripted");

const port = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000").port || "3000";
const ACME = `http://acme.localhost:${port}`;
const FUNTIME = `http://funtime.localhost:${port}`;

const panel = (page: Page) => page.getByRole("dialog", { name: /rental assistant/i });

async function openAssistant(page: Page) {
  await page.getByRole("button", { name: "Ask our assistant" }).click();
  await expect(panel(page)).toBeVisible();
}

async function ask(page: Page, text: string) {
  const before = await panel(page)
    .locator("p", { hasText: /^Assistant: / })
    .count();
  await panel(page).getByLabel("Message the assistant").fill(text);
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect(panel(page).locator("p", { hasText: /^Assistant: / })).toHaveCount(before + 1, {
    timeout: 20_000,
  });
  return panel(page)
    .locator("p", { hasText: /^Assistant: / })
    .last();
}

test("rental → availability → price → quote → booking request; the database matches", async ({
  page,
}) => {
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL to verify the database");
  // A random future Saturday per run (reruns and parallel projects never compete for units).
  const saturday = new Date(Date.UTC(2028, 0, 1 + 7 * Math.floor(Math.random() * 100)));
  saturday.setUTCDate(saturday.getUTCDate() + ((6 - saturday.getUTCDay() + 7) % 7));
  const date = saturday.toISOString().slice(0, 10);
  const email = `e2e-ai-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${ACME}/`);
  await openAssistant(page);

  const found = await ask(page, "Do you have a water slide?");
  await expect(found).toContainText("Sample Wave Slide");
  const productCard = panel(page).getByRole("list", { name: "Suggested rentals" }).last();
  await expect(productCard.getByRole("link", { name: "Sample Wave Slide" })).toHaveAttribute(
    "href",
    "/rentals/sample-wave-slide",
  );

  const avail = await ask(page, `Is it available on ${date} from 12:00 to 16:00?`);
  await expect(avail).toContainText("is available");
  await expect(panel(page).getByTestId("availability-card").last()).toContainText("Available");

  // The conversation survives a reload (server session cookie + this tab's transcript).
  await page.reload();
  await openAssistant(page);
  await expect(panel(page).getByText("Do you have a water slide?")).toBeVisible();

  await ask(page, "How much would that cost?");
  const priceCard = panel(page).getByTestId("price-card").last();
  await expect(priceCard).toBeVisible();

  await expect(await ask(page, `My name is Robin and my email is ${email}`)).toContainText(
    "saved your contact",
  );
  const quoteReply = await ask(page, "Please create my quote");
  const quoteNumber = /Q-\d+/.exec(await quoteReply.innerText())?.[0];
  expect(quoteNumber).toBeTruthy();
  const quoteCard = panel(page).getByTestId("quote-card").last();
  await expect(quoteCard).toContainText(quoteNumber!);

  const booked = await ask(page, "Please request the booking");
  await expect(booked).toContainText(
    "Your booking request has been submitted and the inventory is being held for 15 minutes.",
  );
  await expect(panel(page).getByTestId("booking-card").last()).toContainText("Booking requested");
  await expect(panel(page).getByText(/booking is confirmed|you're booked|paid/i)).toHaveCount(0);

  // What the assistant said is what the database holds.
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query<{
      source: string;
      br: string;
      res: string;
      email: string;
      final: boolean;
      total: string;
      product: string;
    }>(
      `select q.source, b.status::text br, r.status::text res, c.email::text email,
              (not q.manual_review_required or q.review_approved_at is not null) final,
              q.total_cents::text total, qi.product_name product
       from public.quotes q join public.customers c on c.id = q.customer_id
       join public.quote_items qi on qi.quote_id = q.id
       join public.booking_requests b on b.quote_id = q.id join public.reservations r on r.id = b.reservation_id
       join public.organizations o on o.id = q.organization_id
       where o.slug = 'acme' and q.quote_number = $1`,
      [quoteNumber],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "assistant",
      br: "pending",
      res: "held",
      email,
      product: "Sample Wave Slide",
    });
    if (rows[0]!.final) {
      const total = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
        Number(rows[0]!.total) / 100,
      );
      await expect(quoteCard).toContainText(total);
      await expect(priceCard).toContainText(total);
    } else {
      await expect(quoteCard).toContainText("Price pending team review");
    }
  } finally {
    await db.end();
  }

  // The private quote link opens the same quote.
  await quoteCard.getByRole("link", { name: "View your quote" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(quoteNumber!) }),
  ).toBeVisible();
});

test("another tenant's assistant only knows its own catalog", async ({ page }) => {
  await page.goto(`${FUNTIME}/`);
  await openAssistant(page);
  const reply = await ask(page, "Do you have a slide or a popcorn machine to rent?");
  await expect(reply).not.toContainText("Sample Wave Slide");
  await expect(panel(page).getByText("Sample Wave Slide")).toHaveCount(0);
});

test("a failing assistant API shows a neutral message and a retry; the site keeps working", async ({
  page,
}) => {
  await page.goto(`${ACME}/rentals`);
  await page.route("**/api/assistant", (route) => route.fulfill({ status: 500, body: "{}" }));
  await openAssistant(page);
  await ask(page, "Do you have a bounce house?");
  await expect(
    panel(page)
      .getByText(/unavailable right now|try again/i)
      .first(),
  ).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(panel(page).getByText(/Error|stack|500/)).toHaveCount(0);
  // Normal browsing is unaffected.
  await panel(page).getByRole("button", { name: "Close assistant" }).click();
  await page
    .getByRole("link", { name: /Sample Castle/ })
    .first()
    .click();
  await expect(page).toHaveURL(`${ACME}/rentals/sample-castle`);
});

test("mobile: the assistant is a bottom sheet that fits the screen and closes with Escape", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile project only");
  await page.goto(`${ACME}/rentals/sample-castle`);
  await openAssistant(page);
  const box = await panel(page).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport.height - 1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  // Page context: on a product page the assistant knows which product is meant.
  await expect(await ask(page, "Tell me more details about this one")).toContainText(
    "Sample Castle",
  );
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask our assistant" })).toBeFocused();
});

test("the API accepts only a JSON message and page context from the browser", async ({
  request,
}) => {
  const post = (data: string, contentType = "application/json") =>
    request.post(`http://localhost:${port}/api/assistant`, {
      headers: { host: `acme.localhost:${port}`, "content-type": contentType },
      data,
    });
  expect((await post("message=hi", "application/x-www-form-urlencoded")).status()).toBe(415);
  expect((await post(JSON.stringify({ message: "x".repeat(9000) }))).status()).toBe(413);
  expect((await post(JSON.stringify({ message: "x".repeat(1001) }))).status()).toBe(400);
  // No organization, price or anything else can be supplied.
  const injected = await post(
    JSON.stringify({ message: "hi", organizationId: "20000000-0000-4000-8000-000000000001" }),
  );
  expect(injected.status()).toBe(400);
  const res = await post(JSON.stringify({ message: "Do you have a castle?" }));
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(res.headers()["set-cookie"]).toMatch(/rc_ai=[A-Za-z0-9_-]{43}; .*HttpOnly/i);
  const body = (await res.json()) as { status: string; reply: string; correlationId: string };
  expect(body.status).toBe("ok");
  expect(body.correlationId).toBeTruthy();
  // Unknown host: no assistant at all.
  const none = await request.post(`http://localhost:${port}/api/assistant`, {
    headers: { host: `localhost:${port}`, "content-type": "application/json" },
    data: JSON.stringify({ message: "hi" }),
  });
  expect(none.status()).toBe(404);
});
