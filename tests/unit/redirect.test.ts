import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/domain/http/redirect";

describe("safeRedirectPath", () => {
  it.each(["/admin", "/invite?token=abc", "/admin/members#x"])("allows %s", (p) => {
    expect(safeRedirectPath(p)).toBe(p);
  });

  it.each([
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    "admin",
    "/admin\u0000",
    "/a\\b",
    "",
    "/" + "a".repeat(600),
  ])("rejects %s", (p) => {
    expect(safeRedirectPath(p)).toBe("/admin");
  });

  it("rejects non-strings and honours the fallback", () => {
    expect(safeRedirectPath(null, "/")).toBe("/");
    expect(safeRedirectPath(42)).toBe("/admin");
  });
});
