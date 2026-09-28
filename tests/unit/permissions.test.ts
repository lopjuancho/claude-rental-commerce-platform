import { describe, expect, it } from "vitest";
import { assignableRoles, isPermission, isRole, type Permission } from "@/domain/auth/permissions";

describe("assignableRoles", () => {
  it("returns nothing without members.manage", () => {
    expect(assignableRoles(new Set<Permission>(["org.read"]))).toEqual([]);
  });

  it("excludes owner without members.grant_owner (admin)", () => {
    expect(assignableRoles(new Set<Permission>(["members.manage"]))).toEqual([
      "admin",
      "office",
      "staff",
    ]);
  });

  it("includes owner for owners", () => {
    expect(assignableRoles(new Set<Permission>(["members.manage", "members.grant_owner"]))).toEqual(
      ["owner", "admin", "office", "staff"],
    );
  });
});

describe("guards", () => {
  it("recognise only known roles and permissions", () => {
    expect(isRole("owner")).toBe(true);
    expect(isRole("superadmin")).toBe(false);
    expect(isPermission("catalog.write")).toBe(true);
    expect(isPermission("catalog.delete_everything")).toBe(false);
  });
});
