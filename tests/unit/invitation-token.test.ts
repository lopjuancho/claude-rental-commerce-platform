import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "@/server/auth/invitations";

describe("invitation tokens", () => {
  it("are 256-bit, url-safe and unique", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateInvitationToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hash to the same sha256 hex the database computes", async () => {
    const token = generateInvitationToken();
    expect(await hashInvitationToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
  });
});
