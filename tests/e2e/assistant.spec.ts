import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
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

/** A client address per test: the per-IP assistant budget is per test, not shared by the suite. */
const testIp = () =>
  `198.51.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}`;
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": testIp() });
});

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

test("the API accepts only a JSON message and page context; the session exists before any message", async ({
  request,
}) => {
  const ip = testIp();
  const headers = { host: `acme.localhost:${port}`, "cf-connecting-ip": ip };
  const post = (data: string, contentType = "application/json") =>
    request.post(`http://localhost:${port}/api/assistant`, {
      headers: { ...headers, "content-type": contentType },
      data,
    });
  // H2-C: a mutation-capable POST never creates the session (its Set-Cookie could be lost after a
  // quote was made). Without one it is refused before anything runs.
  const noSession = await post(JSON.stringify({ message: "Do you have a castle?" }));
  expect(noSession.status()).toBe(409);
  expect(((await noSession.json()) as { errorCode: string }).errorCode).toBe("SESSION_REQUIRED");
  expect(noSession.headers()["set-cookie"] ?? "").not.toMatch(/rc_ai=/);
  // The bootstrap GET (and every storefront page view) issues it; it runs nothing.
  const boot = await request.get(`http://localhost:${port}/api/assistant`, { headers });
  expect(boot.status()).toBe(204);
  expect(boot.headers()["set-cookie"]).toMatch(/rc_ai=[A-Za-z0-9_-]{43}; .*HttpOnly/i);

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
  expect(res.headers()["set-cookie"] ?? "").not.toMatch(/rc_ai=/);
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

const sessionHash = (token: string) => createHash("sha256").update(`ai:${token}`).digest("hex");

test("New Chat while a reply is in flight: the old reply and session never come back (N1)", async ({
  page,
  context,
}) => {
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL to verify the database");
  const aiCookie = async () => (await context.cookies()).find((c) => c.name === "rc_ai")?.value;
  await page.goto(`${ACME}/`);
  const before = await aiCookie();
  expect(before).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await openAssistant(page);

  // The POST reaches the server now; the browser only gets the answer later.
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let lateSetCookie: string | undefined;
  let delivered = false;
  await page.route("**/api/assistant", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    // Forwarded from Node, which cannot resolve *.localhost: same request, tenant Host header.
    const response = await route.fetch({
      url: req.url().replace("//acme.localhost:", "//127.0.0.1:"),
      headers: { ...(await req.allHeaders()), host: `acme.localhost:${port}` },
    });
    lateSetCookie = response.headers()["set-cookie"];
    await held;
    await route.fulfill({ response });
    delivered = true;
  });
  await panel(page).getByLabel("Message the assistant").fill("Do you have a water slide?");
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect(panel(page).getByText("Checking…")).toBeVisible();

  await panel(page).getByRole("button", { name: "New chat" }).click();
  await expect.poll(aiCookie).not.toBe(before);
  const after = await aiCookie();
  release();
  await expect.poll(() => delivered).toBe(true);
  await page.waitForTimeout(300);

  // The old reply was dropped; the chat is new and empty; the old session did not come back.
  await expect(panel(page).locator("p", { hasText: /^Assistant: / })).toHaveCount(0);
  await expect(panel(page).getByText("Do you have a water slide?")).toHaveCount(0);
  expect(lateSetCookie ?? "").not.toMatch(/rc_ai=/);
  expect(await aiCookie()).toBe(after);
  await page.unroute("**/api/assistant");

  // The next message uses the new session.
  await ask(page, "Do you have a castle?");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const messages = async (token: string) =>
      (
        await db.query<{ content: string }>(
          `select m.content from public.ai_messages m join public.ai_conversations c on c.id = m.conversation_id
           where c.session_hash = $1 and m.role = 'user' order by m.seq`,
          [sessionHash(token)],
        )
      ).rows.map((r) => r.content);
    expect(await messages(after!)).toEqual(["Do you have a castle?"]);
    expect(await messages(before!)).toEqual(["Do you have a water slide?"]);
  } finally {
    await db.end();
  }
});

test("the first mutation-capable reply is lost: retrying the same message gives the same quote with a working link", async ({
  page,
  request,
}) => {
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL to verify the database");
  const ip = testIp();
  const headers = { host: `acme.localhost:${port}`, "cf-connecting-ip": ip };
  // The storefront page view issues the session (as in a browser).
  const home = await request.get(`http://localhost:${port}/`, { headers });
  expect(home.headers()["set-cookie"]).toMatch(/rc_ai=/);
  const email = `lost-${randomUUID().slice(0, 8)}@example.test`;
  const say = async (message: string, requestId = randomUUID().replace(/-/g, "")) =>
    (await (
      await request.post(`http://localhost:${port}/api/assistant`, {
        headers: { ...headers, "content-type": "application/json" },
        data: JSON.stringify({ message, requestId }),
      })
    ).json()) as {
      status: string;
      replayed?: boolean;
      blocks: { type: string; url?: string | null; quoteNumber?: string }[];
    };
  await say("Do you have a water slide?");
  await say(`Is it available on ${randomSaturday()} from 12:00 to 16:00?`);
  await say(`My name is Robin and my email is ${email}`);
  const requestId = randomUUID().replace(/-/g, "");
  const first = await say("Please create my quote", requestId); // …this response is "lost"
  expect(first.status).toBe("ok");
  const retry = await say("Please create my quote", requestId);
  expect(retry).toMatchObject({ status: "ok", replayed: true });
  const card = retry.blocks.find((b) => b.type === "quote");
  expect(card?.url).toMatch(/^\/q\/[A-Za-z0-9_-]{43}$/);
  // The replayed link works and there is exactly one quote.
  await page.goto(`${ACME}${card!.url!}`);
  await expect(
    page.getByRole("heading", { level: 1, name: new RegExp(card!.quoteNumber!) }),
  ).toBeVisible();
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query<{ n: string }>(
      "select count(*)::text n from public.quotes q join public.customers c on c.id = q.customer_id where c.email = $1",
      [email],
    );
    expect(rows[0]!.n).toBe("1");
  } finally {
    await db.end();
  }
});

/** A random future Saturday (reruns and parallel projects never compete for units). */
function randomSaturday(): string {
  const d = new Date(Date.UTC(2029, 0, 1 + 7 * Math.floor(Math.random() * 150)));
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// M1 (Codex review of 88d1f29): a visitor who LANDS on a product or category page can go all the
// way to a booking request — the anonymous visitor identity exists from the first page view.
for (const entry of [
  { name: "product page", url: "/rentals/sample-castle", first: null },
  { name: "category page", url: "/categories/bounce-houses", first: "Do you have a castle?" },
]) {
  test(`fresh browser → ${entry.name} → assistant → quote → booking request`, async ({
    page,
    context,
  }) => {
    expect(await context.cookies()).toEqual([]);
    await page.goto(`${ACME}${entry.url}`);
    expect((await context.cookies()).map((c) => c.name)).toContain("rc_visitor");
    await openAssistant(page);
    if (entry.first) await ask(page, entry.first);
    const date = randomSaturday();
    await ask(page, `Is it available on ${date} from 12:00 to 16:00?`);
    await ask(
      page,
      `My name is Robin and my email is e2e-${randomUUID().slice(0, 8)}@example.test`,
    );
    await ask(page, "Please create my quote");
    const booked = await ask(page, "Please request the booking");
    await expect(booked).toContainText(
      "Your booking request has been submitted and the inventory is being held for 15 minutes.",
    );
    await expect(panel(page).getByText(/reload the page/i)).toHaveCount(0);
  });
}

// M3: every request spends the per-IP budget BEFORE its body is read — malformed, oversized and
// wrong-type ones included — and the body is read with a hard byte ceiling.
test("abuse: malformed, oversized and concurrent requests spend the per-IP budget", async ({
  request,
}) => {
  const post = (ip: string, data: string, contentType = "application/json") =>
    request.post(`http://localhost:${port}/api/assistant`, {
      headers: {
        host: `acme.localhost:${port}`,
        "content-type": contentType,
        "cf-connecting-ip": ip,
      },
      data,
    });
  const ip = () =>
    `198.18.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}`;

  const malformed = ip();
  const statuses: number[] = [];
  for (let i = 0; i < 30; i++) statuses.push((await post(malformed, "{not json")).status());
  expect(new Set(statuses)).toEqual(new Set([400]));
  expect((await post(malformed, JSON.stringify({ message: "hi" }))).status()).toBe(429);

  const oversized = ip();
  const big = JSON.stringify({ message: "x".repeat(20_000) });
  const bigStatuses: number[] = [];
  for (let i = 0; i < 30; i++) bigStatuses.push((await post(oversized, big)).status());
  expect(new Set(bigStatuses)).toEqual(new Set([413]));
  expect((await post(oversized, big)).status()).toBe(429);

  const wrongType = ip();
  for (let i = 0; i < 30; i++) await post(wrongType, "message=hi", "text/plain");
  expect((await post(wrongType, "message=hi", "text/plain")).status()).toBe(429);

  const concurrent = ip();
  const burst = await Promise.all(
    Array.from({ length: 40 }, () => post(concurrent, "{not json").then((r) => r.status())),
  );
  expect(burst.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10);
  expect(burst.filter((s) => s === 400).length).toBeLessThanOrEqual(30);
});

test("a chunked body without Content-Length is cut off at the limit (413)", async () => {
  const status = await new Promise<number | "closed">((resolve) => {
    let done = false;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(port),
        path: "/api/assistant",
        method: "POST",
        headers: {
          host: `acme.localhost:${port}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
          "cf-connecting-ip": `198.19.${String(Math.floor(Math.random() * 250))}.1`,
        },
      },
      (res) => {
        done = true;
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", () => {
      if (!done) resolve("closed");
    });
    const chunk = `{"message":"${"x".repeat(16 * 1024)}`;
    let sent = 0;
    const write = () => {
      while (!done && sent < 8 * 1024 * 1024) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once("drain", write);
          return;
        }
      }
      req.end();
    };
    write();
  });
  expect(status === 413 || status === "closed").toBe(true);
});
