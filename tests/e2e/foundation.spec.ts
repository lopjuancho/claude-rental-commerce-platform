import { expect, test } from "@playwright/test";

/**
 * Milestone 1 smoke tests that need only the Next.js server. Flows that need Supabase Auth
 * (sign-in, invitation acceptance, org switching) run in CI against the Supabase stack.
 */
test("health endpoint responds without leaking configuration", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("responses carry security headers", async ({ request }) => {
  const res = await request.get("/sign-in");
  const headers = res.headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).toMatch(/'nonce-[^']+'/);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
});

test("admin requires sign-in and preserves a safe return path", async ({ page }) => {
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fadmin%2Fmembers$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("open redirects are neutralised on the sign-in page", async ({ page }) => {
  await page.goto("/sign-in?next=//evil.example.com");
  await expect(page.locator('input[name="next"]')).toHaveValue("/admin");
});

test("invitation page never accepts on GET", async ({ page }) => {
  await page.goto(`/invite?token=${"a".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "You've been invited" })).toBeVisible();
});

test("catalog admin pages require sign-in", async ({ page }) => {
  for (const path of [
    "/admin/catalog",
    "/admin/catalog/import",
    "/admin/catalog/categories",
    "/admin/availability",
    "/admin/availability/blocks",
    "/admin/availability/weather",
    "/admin/pricing",
    "/admin/pricing/delivery",
    "/admin/pricing/tax",
    "/admin/pricing/calculator",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(path)}$`));
  }
});
