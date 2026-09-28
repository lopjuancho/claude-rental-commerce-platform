import { describe, expect, it } from "vitest";
import { isValidSlug, normalizeHost } from "@/domain/tenancy/host";

describe("normalizeHost", () => {
  it.each([
    ["TikyJumps.com", "tikyjumps.com"],
    ["acme.localhost:3000", "acme.localhost"],
    ["shop.example.com.", "shop.example.com"],
    ["  spaced.example.com  ", "spaced.example.com"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it.each([
    [null],
    [""],
    ["[::1]:3000"],
    ["evil.com:abc"],
    ["bad_host.com"],
    ["a..b.com"],
    ["-lead.example.com"],
    ["x.com/path"],
    ["user@x.com"],
    ["x".repeat(254)],
  ])("rejects %s", (input) => {
    expect(normalizeHost(input)).toBeNull();
  });
});

describe("isValidSlug", () => {
  it.each(["acme", "tiky-jumps", "a1"])("accepts %s", (s) => {
    expect(isValidSlug(s)).toBe(true);
  });
  it.each(["a", "-acme", "acme-", "ac--me", "Acme", "acme_x", "x".repeat(64)])(
    "rejects %s",
    (s) => {
      expect(isValidSlug(s)).toBe(false);
    },
  );
});
