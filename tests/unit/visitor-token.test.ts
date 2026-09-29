import { describe, expect, it } from "vitest";
import {
  generateVisitorToken,
  hashVisitorToken,
  isWellFormedVisitorToken,
  shouldIssueVisitorCookie,
  VISITOR_COOKIE,
  visitorCookieOptions,
} from "@/server/visitor-token";
import { hashQuoteToken } from "@/server/quotes/token";

describe("anonymous visitor token", () => {
  it("is 256 random bits, base64url, unique", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateVisitorToken()));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("accepts only well-formed tokens", () => {
    expect(isWellFormedVisitorToken(generateVisitorToken())).toBe(true);
    for (const bad of ["", "short", `${"a".repeat(42)}!`, "a".repeat(44), "a".repeat(200)]) {
      expect(isWellFormedVisitorToken(bad)).toBe(false);
    }
  });

  it("is hashed (SHA-256 hex, domain-separated from quote links) before it reaches the database", async () => {
    const t = generateVisitorToken();
    const h = await hashVisitorToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(await hashVisitorToken(t)).toBe(h);
    expect(h).not.toBe(await hashQuoteToken(t)); // a leaked quote-link hash is not a visitor hash
  });

  it("lives in an HttpOnly, SameSite=Lax cookie (Secure in production), carrying no PII", () => {
    expect(VISITOR_COOKIE).toMatch(/^[a-z_]+$/);
    expect(visitorCookieOptions(true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(visitorCookieOptions(false).secure).toBe(false);
    expect(visitorCookieOptions(true).maxAge).toBeGreaterThan(0);
  });

  it("is issued only by storefront page views, never by actions (POST) or admin/auth pages", () => {
    for (const path of ["/", "/quote", "/q/abc"]) {
      expect(shouldIssueVisitorCookie("GET", path, undefined)).toBe(true);
      expect(shouldIssueVisitorCookie("HEAD", path, "bad")).toBe(true);
      expect(shouldIssueVisitorCookie("POST", path, undefined)).toBe(false); // server actions
      expect(shouldIssueVisitorCookie("GET", path, generateVisitorToken())).toBe(false); // kept
    }
    for (const path of ["/admin", "/admin/quotes", "/sign-in", "/api/health", "/invite"]) {
      expect(shouldIssueVisitorCookie("GET", path, undefined)).toBe(false);
    }
  });
});
