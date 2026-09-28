import { beforeAll, describe, expect, it } from "vitest";
import { admin, as, createOrg, createUser, expectDenied, type TestOrg } from "./support/db";

let a: TestOrg;
let b: TestOrg;

beforeAll(async () => {
  a = await createOrg("roles-a");
  b = await createOrg("roles-b");
});

const settingsUpdate =
  "update public.organization_settings set primary_color = '#123456' where organization_id = $1";

describe("permission matrix", () => {
  it.each([
    ["owner", 1],
    ["admin", 1],
    ["office", 0],
    ["staff", 0],
  ] as const)("%s updating settings affects %i row(s)", async (role, expected) => {
    const n = await as(a.users[role], async (sql) => (await sql(settingsUpdate, [a.id])).rowCount);
    expect(n).toBe(expected);
  });

  it("every role can read its own organization", async () => {
    for (const role of ["owner", "admin", "office", "staff"] as const) {
      const rows = await as(
        a.users[role],
        async (sql) => (await sql("select id from public.organizations")).rows,
      );
      expect(rows).toEqual([{ id: a.id }]);
    }
  });

  it("a user with no membership sees nothing", async () => {
    const outsider = await createUser("outsider");
    const counts = await as(outsider, async (sql) => ({
      orgs: (await sql("select count(*)::int n from public.organizations")).rows[0],
      members: (await sql("select count(*)::int n from public.organization_members")).rows[0],
    }));
    expect(counts).toEqual({ orgs: { n: 0 }, members: { n: 0 } });
  });

  it("suspended members lose access", async () => {
    const user = await createUser("suspended");
    await admin("insert into public.organization_members values ($1, $2, 'office', 'suspended')", [
      a.id,
      user.id,
    ]);
    const n = await as(
      user,
      async (sql) => (await sql("select count(*)::int n from public.organizations")).rows[0],
    );
    expect(n).toEqual({ n: 0 });
  });

  it("members of a closed organization lose access", async () => {
    const closed = await createOrg("closed", "closed");
    const n = await as(
      closed.users.owner,
      async (sql) => (await sql("select count(*)::int n from public.organizations")).rows[0],
    );
    expect(n).toEqual({ n: 0 });
  });
});

describe("platform-controlled columns", () => {
  it.each(["status", "plan", "slug"])("an owner cannot change organizations.%s", async (column) => {
    await as(a.users.owner, async (sql) => {
      await expectDenied(
        sql(`update public.organizations set ${column} = ${column} where id = $1`, [a.id]),
      );
    });
  });

  it("an owner can rename the organization", async () => {
    const n = await as(
      a.users.owner,
      async (sql) =>
        (await sql("update public.organizations set name = 'Renamed' where id = $1", [a.id]))
          .rowCount,
    );
    expect(n).toBe(1);
  });

  it("tenants cannot add domains (prevents claiming another business's hostname)", async () => {
    await as(a.users.owner, async (sql) => {
      await expectDenied(
        sql(
          "insert into public.organization_domains (organization_id, hostname) values ($1, 'evil.example.com')",
          [a.id],
        ),
      );
    });
  });

  it("organization_id cannot be moved to another tenant, even by service_role", async () => {
    await admin(
      "insert into public.organization_policies (organization_id, policy_type, title, body) values ($1, 'other', 'T', 'B')",
      [a.id],
    );
    await as({ kind: "service" }, async (sql) => {
      await expectDenied(
        sql(
          "update public.organization_policies set organization_id = $1 where organization_id = $2",
          [b.id, a.id],
        ),
        ["23514"],
      );
    });
  });

  it("role_permissions cannot be modified through the API", async () => {
    await as(a.users.owner, async (sql) => {
      await expectDenied(
        sql("insert into public.role_permissions values ('staff', 'settings.write')"),
      );
    });
  });

  it("organizations cannot be created directly or via create_organization by users", async () => {
    await as(a.users.owner, (sql) =>
      expectDenied(sql("insert into public.organizations (slug, name) values ('x-new', 'X')")),
    );
    await as(a.users.owner, (sql) =>
      expectDenied(
        sql("select public.create_organization('x-new', 'X', 'UTC', $1)", [a.users.owner.id]),
      ),
    );
  });
});

describe("membership management", () => {
  it("members cannot be inserted directly (only via invitations)", async () => {
    const newcomer = await createUser("newcomer");
    await as(a.users.owner, async (sql) => {
      await expectDenied(
        sql(
          "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'staff')",
          [a.id, newcomer.id],
        ),
      );
    });
  });

  it("an admin can change office → staff", async () => {
    const n = await as(
      a.users.admin,
      async (sql) =>
        (
          await sql(
            "update public.organization_members set role = 'staff' where organization_id = $1 and user_id = $2",
            [a.id, a.users.office.id],
          )
        ).rowCount,
    );
    expect(n).toBe(1);
  });

  it("an admin cannot promote anyone to owner", async () => {
    await as(a.users.admin, async (sql) => {
      await expectDenied(
        sql(
          "update public.organization_members set role = 'owner' where organization_id = $1 and user_id = $2",
          [a.id, a.users.staff.id],
        ),
      );
    });
  });

  it("an admin cannot demote or remove an owner", async () => {
    await as(a.users.admin, async (sql) => {
      await expectDenied(
        sql(
          "update public.organization_members set role = 'staff' where organization_id = $1 and user_id = $2",
          [a.id, a.users.owner.id],
        ),
      );
    });
    await as(a.users.admin, async (sql) => {
      await expectDenied(
        sql("delete from public.organization_members where organization_id = $1 and user_id = $2", [
          a.id,
          a.users.owner.id,
        ]),
      );
    });
  });

  it("an owner can promote another member to owner", async () => {
    const n = await as(
      a.users.owner,
      async (sql) =>
        (
          await sql(
            "update public.organization_members set role = 'owner' where organization_id = $1 and user_id = $2",
            [a.id, a.users.admin.id],
          )
        ).rowCount,
    );
    expect(n).toBe(1);
  });

  it("the last active owner cannot be removed or demoted", async () => {
    await as(a.users.owner, async (sql) => {
      await expectDenied(
        sql("delete from public.organization_members where organization_id = $1 and user_id = $2", [
          a.id,
          a.users.owner.id,
        ]),
        ["23514"],
      );
    });
    await as(a.users.owner, async (sql) => {
      await expectDenied(
        sql(
          "update public.organization_members set status = 'suspended' where organization_id = $1 and user_id = $2",
          [a.id, a.users.owner.id],
        ),
        ["23514"],
      );
    });
  });

  it("staff and office cannot manage members", async () => {
    for (const role of ["office", "staff"] as const) {
      const n = await as(
        a.users[role],
        async (sql) =>
          (
            await sql(
              "delete from public.organization_members where organization_id = $1 and user_id = $2",
              [a.id, a.users.staff.id],
            )
          ).rowCount,
      );
      expect(n).toBe(0);
    }
  });

  it("an owner of B cannot touch A's memberships", async () => {
    const n = await as(
      b.users.owner,
      async (sql) =>
        (
          await sql(
            "update public.organization_members set role = 'staff' where organization_id = $1",
            [a.id],
          )
        ).rowCount,
    );
    expect(n).toBe(0);
  });

  it("deleting an organization cascades memberships despite the owner guard", async () => {
    const doomed = await createOrg("doomed");
    await admin("delete from public.organizations where id = $1", [doomed.id]);
    const { rows } = await admin(
      "select count(*)::int n from public.organization_members where organization_id = $1",
      [doomed.id],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("user profiles", () => {
  it("co-members can read each other's profiles; other tenants' profiles are invisible", async () => {
    const ids = await as(
      a.users.staff,
      async (sql) =>
        (
          await sql("select id from public.user_profiles where id = any($1)", [
            [a.users.owner.id, b.users.owner.id],
          ])
        ).rows,
    );
    expect(ids).toEqual([{ id: a.users.owner.id }]);
  });

  it("a user can update only their own profile", async () => {
    const own = await as(
      a.users.staff,
      async (sql) =>
        (
          await sql("update public.user_profiles set full_name = 'Me' where id = $1", [
            a.users.staff.id,
          ])
        ).rowCount,
    );
    const other = await as(
      a.users.staff,
      async (sql) =>
        (
          await sql("update public.user_profiles set full_name = 'Hacked' where id = $1", [
            a.users.owner.id,
          ])
        ).rowCount,
    );
    expect([own, other]).toEqual([1, 0]);
  });
});

describe("code ↔ database permission names", () => {
  it("PERMISSIONS in src/domain matches role_permissions", async () => {
    const { PERMISSIONS } = await import("@/domain/auth/permissions");
    const { rows } = await admin<{ permission: string }>(
      "select distinct permission from public.role_permissions order by 1",
    );
    expect(rows.map((r) => r.permission)).toEqual([...PERMISSIONS].sort());
  });
});
