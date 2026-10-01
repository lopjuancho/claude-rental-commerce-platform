import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { type BrowserContext, expect, type Page, type Route, test } from "@playwright/test";
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
/** The assistant endpoint, with or without the session-generation query (?g=N). */
const ASSISTANT_API = /\/api\/assistant(?:\?.*)?$/;

/** Session cookies by generation (`rc_ai` = 0, `rc_ai_<n>`); the server uses the highest. */
const SESSION_COOKIE = /^rc_ai(?:_([1-9]\d*))?$/;
async function sessionCookies(context: BrowserContext) {
  return (await context.cookies(ACME))
    .flatMap((c) => {
      const m = SESSION_COOKIE.exec(c.name);
      return m ? [{ name: c.name, generation: Number(m[1] ?? 0), value: c.value }] : [];
    })
    .sort((a, b) => b.generation - a.generation);
}
/** The session in effect for this browser (the highest generation). */
const aiSession = async (context: BrowserContext) => (await sessionCookies(context))[0]?.value;

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
  await page.route(ASSISTANT_API, (route) => route.fulfill({ status: 500, body: "{}" }));
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
  expect(noSession.headers()["set-cookie"] ?? "").not.toMatch(/rc_ai(?:_\d+)?=/);
  // The bootstrap GET (and every storefront page view) issues it; it runs nothing.
  const boot = await request.get(`http://localhost:${port}/api/assistant`, { headers });
  expect(boot.status()).toBe(204);
  expect(boot.headers()["set-cookie"]).toMatch(/rc_ai_1=[A-Za-z0-9_-]{43}; .*HttpOnly/i);

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
  expect(res.headers()["set-cookie"] ?? "").not.toMatch(/rc_ai(?:_\d+)?=/);
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
  const aiCookie = () => aiSession(context);
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
  await page.route(ASSISTANT_API, async (route) => {
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
  expect(lateSetCookie ?? "").not.toMatch(/rc_ai(?:_\d+)?=/);
  expect(await aiCookie()).toBe(after);
  await page.unroute(ASSISTANT_API);

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

// R3-M2: nothing is sent until the session replacement (New Chat) or bootstrap is confirmed for
// the same chat generation.
function recordPosts(page: Page) {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (ASSISTANT_API.test(r.url()) && r.method() === "POST") posts.push(r.postData() ?? "");
  });
  return posts;
}
function holdMethod(page: Page, method: "DELETE" | "GET", fail = false) {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const seen: number[] = [];
  const ready = page.route(ASSISTANT_API, async (route) => {
    if (route.request().method() !== method) return route.continue();
    seen.push(Date.now());
    await held;
    if (fail) return route.fulfill({ status: 500, body: "" });
    return route.continue();
  });
  return { release, seen, ready };
}

test("New Chat with a slow DELETE: nothing can be sent until the new session is confirmed", async ({
  page,
}) => {
  await page.goto(`${ACME}/`);
  await openAssistant(page);
  const posts = recordPosts(page);
  const del = holdMethod(page, "DELETE");
  await del.ready;
  await panel(page).getByRole("button", { name: "New chat" }).click();
  await expect(panel(page).getByText("Starting a new chat…")).toBeVisible();
  await panel(page).getByLabel("Message the assistant").fill("Do you have a castle?");
  await expect(panel(page).getByRole("button", { name: "Send" })).toBeDisabled();
  await panel(page).getByLabel("Message the assistant").press("Enter");
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(0);
  del.release();
  await expect(panel(page).getByText("Starting a new chat…")).toHaveCount(0);
  await page.unroute(ASSISTANT_API);
  await ask(page, "Do you have a castle?");
  expect(posts).toHaveLength(1);
});

test("New Chat whose DELETE fails: an explicit error, and nothing goes to the old session", async ({
  page,
  context,
}) => {
  await page.goto(`${ACME}/`);
  const before = await aiSession(context);
  await openAssistant(page);
  const posts = recordPosts(page);
  const del = holdMethod(page, "DELETE", true);
  await del.ready;
  del.release();
  await panel(page).getByRole("button", { name: "New chat" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("couldn't start a new chat");
  await panel(page).getByLabel("Message the assistant").fill("Do you have a castle?");
  await expect(panel(page).getByRole("button", { name: "Send" })).toBeDisabled();
  await panel(page).getByLabel("Message the assistant").press("Enter");
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(0);
  expect(await aiSession(context)).toBe(before);
  // Retrying succeeds: a new session, then messages go there.
  await page.unroute(ASSISTANT_API);
  await panel(page).getByRole("button", { name: "Retry new chat" }).click();
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  await expect(panel(page).getByText("Starting a new chat…")).toHaveCount(0);
  await expect.poll(() => aiSession(context)).not.toBe(before);
  await ask(page, "Do you have a castle?");
  expect(posts).toHaveLength(1);
});

test("New Chat during a delayed session bootstrap: the old continuation never posts", async ({
  page,
}) => {
  await page.goto(`${ACME}/`);
  await openAssistant(page);
  const posts = recordPosts(page);
  // The session has expired: the first POST is refused (SESSION_REQUIRED) and the widget
  // bootstraps one with a GET — which is slow. (Answered by the route so no page-view prefetch can
  // re-issue the cookie first.)
  let refused = false;
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const gets: number[] = [];
  await page.route(ASSISTANT_API, async (route) => {
    const method = route.request().method();
    if (method === "POST" && !refused) {
      refused = true;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          status: "error",
          errorCode: "SESSION_REQUIRED",
          reply: "Please reload the page to start the assistant.",
          blocks: [],
        }),
      });
    }
    if (method === "GET") {
      gets.push(1);
      await held;
    }
    return route.continue();
  });
  await panel(page).getByLabel("Message the assistant").fill("Do you have a water slide?");
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect.poll(() => gets.length).toBe(1); // bootstrap GET in flight
  await panel(page).getByRole("button", { name: "New chat" }).click();
  await expect(panel(page).getByText("Starting a new chat…")).toHaveCount(0);
  release();
  await page.waitForTimeout(500);
  // Only the first (refused) POST ever happened for that message; the new chat is empty.
  expect(posts.filter((p) => p.includes("water slide"))).toHaveLength(1);
  await expect(panel(page).getByText("Do you have a water slide?")).toHaveCount(0);
  await page.unroute(ASSISTANT_API);
  await ask(page, "Do you have a castle?");
});

test("rapid New Chat clicks: one replacement at a time, then a working new chat", async ({
  page,
}) => {
  await page.goto(`${ACME}/`);
  await openAssistant(page);
  const deletes: number[] = [];
  page.on("request", (r) => {
    if (ASSISTANT_API.test(r.url()) && r.method() === "DELETE") deletes.push(1);
  });
  const del = holdMethod(page, "DELETE");
  await del.ready;
  const newChat = panel(page).getByRole("button", { name: "New chat" });
  await newChat.click();
  await expect(newChat).toBeDisabled();
  for (let i = 0; i < 3; i++) await newChat.dispatchEvent("click");
  await page.waitForTimeout(200);
  expect(deletes).toHaveLength(1);
  del.release();
  await expect(newChat).toBeEnabled();
  await page.unroute(ASSISTANT_API);
  await newChat.click();
  await expect(newChat).toBeEnabled();
  expect(deletes).toHaveLength(2);
  await ask(page, "Do you have a castle?");
});

// ── R3-M2 round 4: a late, REAL Set-Cookie from an older bootstrap never replaces a newer session.

/** Forwards a request from Node (which cannot resolve *.localhost) with the tenant Host header. */
async function forward(route: Route) {
  const req = route.request();
  return route.fetch({
    url: req.url().replace("//acme.localhost:", "//127.0.0.1:"),
    headers: { ...(await req.allHeaders()), host: `acme.localhost:${port}` },
  });
}

/**
 * From now on the page makes no request but the assistant's: no link prefetch or navigation can
 * reach the middleware and issue a (generation 0) session while a test controls the cookies.
 */
async function onlyAssistantRequests(page: Page, context: BrowserContext) {
  await page.route(
    (url) => !ASSISTANT_API.test(url.toString()),
    (route) => route.abort(),
  );
  await context.clearCookies({ name: SESSION_COOKIE });
}

/** User messages stored for a session token, in order. */
async function storedMessages(token: string): Promise<string[]> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return (
      await db.query<{ content: string }>(
        `select m.content from public.ai_messages m join public.ai_conversations c on c.id = m.conversation_id
         where c.session_hash = $1 and m.role = 'user' order by m.seq`,
        [sessionHash(token)],
      )
    ).rows.map((r) => r.content);
  } finally {
    await db.end();
  }
}

/**
 * The widget starts without a session: its first POST is refused (SESSION_REQUIRED) and it sends
 * the bootstrap GET. That GET reaches the REAL server, which issues session B — but the response
 * (with its Set-Cookie) is held and delivered only when `release` is called.
 */
async function heldBootstrap(page: Page) {
  let refused = false;
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const state = { issued: "", delivered: false, gets: 0 };
  await page.route(ASSISTANT_API, async (route) => {
    const method = route.request().method();
    if (method === "POST" && !refused) {
      refused = true;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          status: "error",
          errorCode: "SESSION_REQUIRED",
          reply: "Please reload the page to start the assistant.",
          blocks: [],
        }),
      });
    }
    if (method === "GET" && state.gets === 0) {
      state.gets++;
      const response = await forward(route);
      state.issued = response.headers()["set-cookie"] ?? "";
      await held;
      await route.fulfill({ response }); // the browser applies B's Set-Cookie NOW (late)
      state.delivered = true;
      return;
    }
    return route.continue();
  });
  return { release, state };
}

test("a bootstrap response delivered AFTER New Chat cannot switch the chat back (real Set-Cookie)", async ({
  page,
  context,
}) => {
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL to verify the database");
  await page.goto(`${ACME}/`);
  await openAssistant(page);
  await onlyAssistantRequests(page, context); // 1. no session cookie
  const boot = await heldBootstrap(page);
  // 2. the bootstrap GET starts; its response is held before its Set-Cookie reaches the browser.
  await panel(page).getByLabel("Message the assistant").fill("Do you have a water slide?");
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect.poll(() => boot.state.issued).toMatch(/rc_ai_\d+=[A-Za-z0-9_-]{43}/);
  const b = /rc_ai_(\d+)=([A-Za-z0-9_-]{43})/.exec(boot.state.issued)!;
  // 3-4. New Chat completes and establishes session N.
  await panel(page).getByRole("button", { name: "New chat" }).click();
  await expect(panel(page).getByText("Starting a new chat…")).toHaveCount(0);
  const n = await aiSession(context);
  expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(n).not.toBe(b[2]);
  // 5. a successful message in N.
  await ask(page, "Do you have a castle?");
  // 6. the old bootstrap response arrives and its Set-Cookie IS applied…
  boot.release();
  await expect.poll(() => boot.state.delivered).toBe(true);
  await expect
    .poll(
      async () => (await sessionCookies(context)).find((c) => c.name === `rc_ai_${b[1]}`)?.value,
    )
    .toBe(b[2]);
  // 7-8. …but under a LOWER generation: the session in effect is still N.
  expect(await aiSession(context)).toBe(n);
  // 9. the next message appends to N.
  await ask(page, "Is it available next Saturday?");
  await page.unroute(ASSISTANT_API);
  // 10. the database: both messages in the replacement conversation; B never received one; the
  // abandoned continuation ("water slide") never posted.
  expect(await storedMessages(n!)).toEqual([
    "Do you have a castle?",
    "Is it available next Saturday?",
  ]);
  expect(await storedMessages(b[2]!)).toEqual([]);
  await expect(panel(page).getByText("Do you have a water slide?")).toHaveCount(0);
});

test("bootstrap held across TWO New Chat resets: messages stay in the latest session", async ({
  page,
  context,
}) => {
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL to verify the database");
  await page.goto(`${ACME}/`);
  await openAssistant(page);
  await onlyAssistantRequests(page, context);
  const boot = await heldBootstrap(page);
  await panel(page).getByLabel("Message the assistant").fill("Do you have a water slide?");
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect.poll(() => boot.state.issued).toMatch(/rc_ai_\d+=/);
  const newChat = panel(page).getByRole("button", { name: "New chat" });
  await newChat.click();
  await expect(panel(page).getByText("Starting a new chat…")).toHaveCount(0);
  const n1 = await aiSession(context);
  await newChat.click();
  await expect(panel(page).getByText("Starting a new chat…")).toHaveCount(0);
  const n2 = await aiSession(context);
  expect(n2).not.toBe(n1);
  await ask(page, "Do you have a castle?");
  boot.release();
  await expect.poll(() => boot.state.delivered).toBe(true);
  expect(await aiSession(context)).toBe(n2);
  await ask(page, "Is it available next Saturday?");
  await page.unroute(ASSISTANT_API);
  expect(await storedMessages(n2!)).toEqual([
    "Do you have a castle?",
    "Is it available next Saturday?",
  ]);
  expect(await storedMessages(n1!)).toEqual([]);
  // Superseded generations are expired by the next reset: the jar does not grow.
  expect((await sessionCookies(context)).length).toBeLessThanOrEqual(2);
});

test("two bootstrap GETs racing: the one SENT later wins even when it arrives first", async ({
  page,
  context,
}) => {
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL to verify the database");
  await page.goto(`${ACME}/`);
  await openAssistant(page);
  await onlyAssistantRequests(page, context);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let firstDelivered = false;
  await page.route(/\/api\/assistant\?g=2$/, async (route) => {
    const response = await forward(route);
    await held;
    await route.fulfill({ response });
    firstDelivered = true;
  });
  // Two bootstraps from the same (empty) cookie state, numbered in send order.
  const first = page.evaluate(() => fetch("/api/assistant?g=2").then((r) => r.status));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => fetch("/api/assistant?g=3").then((r) => r.status))).toBe(204);
  const winner = await aiSession(context);
  release();
  expect(await first).toBe(204);
  expect(firstDelivered).toBe(true);
  expect((await sessionCookies(context)).map((c) => c.name)).toEqual(
    expect.arrayContaining(["rc_ai_3", "rc_ai_2"]),
  );
  expect(await aiSession(context)).toBe(winner);
  await page.unroute(/\/api\/assistant\?g=2$/);
  await ask(page, "Do you have a castle?");
  expect(await storedMessages(winner!)).toEqual(["Do you have a castle?"]);
});

test("HTTP responses never carry a quote token hash or session hash, live or replayed", async ({
  request,
}) => {
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL to verify the database");
  const headers = { host: `acme.localhost:${port}`, "cf-connecting-ip": testIp() };
  await request.get(`http://localhost:${port}/`, { headers });
  const bodies: string[] = [];
  const observed: { calls: string | undefined; telemetry: string | undefined }[] = [];
  const say = async (message: string, requestId = randomUUID().replace(/-/g, "")) => {
    const res = await request.post(`http://localhost:${port}/api/assistant`, {
      headers: { ...headers, "content-type": "application/json" },
      data: JSON.stringify({ message, requestId }),
    });
    const text = await res.text();
    bodies.push(text);
    observed.push({
      calls: res.headers()["x-assistant-model-calls"],
      telemetry: res.headers()["x-assistant-telemetry"],
    });
    return JSON.parse(text) as {
      status: string;
      reply: string;
      replayed?: boolean;
      blocks: { type: string; status?: string; quoteNumber?: string }[];
    };
  };
  const email = `leak-${randomUUID().slice(0, 8)}@example.test`;
  await say("Do you have a water slide?");
  await say(`Is it available on ${randomSaturday()} from 12:00 to 16:00?`);
  await say(`My name is Robin and my email is ${email}`);
  const quote = await say("Please create my quote");
  expect(quote.status).toBe("ok");
  const bookingKey = randomUUID().replace(/-/g, "");
  const booked = await say("Please request the booking", bookingKey);
  expect(booked.blocks.find((b) => b.type === "booking")).toBeTruthy();
  const replay = await say("Please request the booking", bookingKey); // lost response → replay
  expect(replay.replayed).toBe(true);
  // Provider observation (headers only): the live turn made model calls with complete
  // telemetry; its replay made none.
  expect(Number(observed.at(-2)?.calls)).toBeGreaterThanOrEqual(1);
  expect(observed.at(-2)?.telemetry).toBe("complete");
  expect(observed.at(-1)).toEqual({ calls: "0", telemetry: "complete" });
  expect(replay.reply).toMatch(/^Here is where your request stands now\./);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let tokenHash: string;
  try {
    tokenHash = (
      await db.query<{ token_hash: string }>(
        "select q.token_hash from public.quotes q join public.customers c on c.id = q.customer_id where c.email = $1",
        [email],
      )
    ).rows[0]!.token_hash;
  } finally {
    await db.end();
  }
  for (const body of bodies) {
    expect(body).not.toContain(tokenHash);
    expect(body).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(body).not.toMatch(/quoteRef|sealedLink|"refs"/);
  }
});

test("a replayed availability answer shows no old Available/Unavailable card (R3-M1)", async ({
  request,
}) => {
  const headers = { host: `acme.localhost:${port}`, "cf-connecting-ip": testIp() };
  await request.get(`http://localhost:${port}/`, { headers });
  const say = async (message: string, requestId: string) =>
    (await (
      await request.post(`http://localhost:${port}/api/assistant`, {
        headers: { ...headers, "content-type": "application/json" },
        data: JSON.stringify({ message, requestId }),
      })
    ).json()) as { reply: string; replayed?: boolean; blocks: { type: string }[] };
  await say("Do you have a water slide?", randomUUID().replace(/-/g, ""));
  const key = randomUUID().replace(/-/g, "");
  const question = `Is it available on ${randomSaturday()} from 12:00 to 16:00?`;
  const first = await say(question, key);
  expect(first.blocks.some((b) => b.type === "availability")).toBe(true);
  const replay = await say(question, key); // the first response was "lost"
  expect(replay.replayed).toBe(true);
  expect(replay.blocks.some((b) => b.type === "availability")).toBe(false);
  expect(replay.reply).toMatch(/Availability needs to be checked again/);
  expect(replay.reply).not.toMatch(/is available|not available|unavailable/i);
});
