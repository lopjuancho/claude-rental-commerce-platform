import { expect, test } from "@playwright/test";

/**
 * L1 (Codex review of 610acf0): the anonymous visitor identity is established by storefront page
 * views, BEFORE any booking action runs; booking actions only read it and never mint one. So
 * simultaneous first-use actions cannot each create their own identity.
 */
const VISITOR = "rc_visitor";
const visitorSetCookies = (headers: { name: string; value: string }[]) =>
  headers.filter((h) => h.name.toLowerCase() === "set-cookie" && h.value.startsWith(`${VISITOR}=`));

test("concurrent first storefront requests leave exactly one visitor identity, with safe attributes", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const pages = await Promise.all([1, 2, 3, 4].map(() => context.newPage()));
  await Promise.all(
    pages.map((p, i) => p.goto(i % 2 === 0 ? "/quote" : `/q/${"a".repeat(43)}`).catch(() => null)),
  );
  const cookies = (await context.cookies()).filter((c) => c.name === VISITOR);
  expect(cookies).toHaveLength(1);
  const [c] = cookies;
  expect(c!.value).toMatch(/^[A-Za-z0-9_-]{43}$/); // opaque 256-bit token, no PII
  expect(c!.httpOnly).toBe(true);
  expect(c!.sameSite).toBe("Lax");
  expect(c!.path).toBe("/");
  expect(c!.secure).toBe(true); // production build
  expect(c!.expires).toBeGreaterThan(Date.now() / 1000 + 60 * 60 * 24 * 30);

  // Stable: a later page view neither replaces nor re-issues it.
  const again = await pages[0]!.goto("/quote").catch(() => null);
  if (again) expect(visitorSetCookies(await again.headersArray())).toEqual([]);
  expect((await context.cookies()).filter((x) => x.name === VISITOR)).toEqual(cookies);
  await context.close();
});

// The real booking action (no cookie → refused, no hold, never minted; shared cookie → cap holds)
// is exercised in tests/integration/booking-action.test.ts against the database.

test("admin and sign-in pages do not receive a visitor cookie", async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL: baseURL! });
  for (const path of ["/sign-in", "/admin/members", "/api/health"]) {
    const res = await api.get(path, { maxRedirects: 0, failOnStatusCode: false });
    expect(visitorSetCookies(res.headersArray()), path).toEqual([]);
  }
  await api.dispose();
});
