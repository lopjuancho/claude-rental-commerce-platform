import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, STATIC_SECURITY_HEADERS } from "@/server/security/headers";

describe("content security policy", () => {
  const prod = buildContentSecurityPolicy({
    nonce: "abc",
    supabaseUrl: "https://x.supabase.co",
    isDev: false,
  });

  it("uses a nonce and no unsafe-eval in production", () => {
    expect(prod).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(prod).not.toContain("unsafe-eval");
    expect(prod).toContain("upgrade-insecure-requests");
  });

  it("forbids framing, plugins and foreign form targets", () => {
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain("form-action 'self'");
  });

  it("allows eval only in development", () => {
    expect(
      buildContentSecurityPolicy({
        nonce: "n",
        supabaseUrl: "http://127.0.0.1:54321",
        isDev: true,
      }),
    ).toContain("'unsafe-eval'");
  });

  it("sets HSTS and nosniff", () => {
    expect(STATIC_SECURITY_HEADERS["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
    expect(STATIC_SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});
