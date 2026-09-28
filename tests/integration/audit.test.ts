import { beforeAll, describe, expect, it } from "vitest";
import { admin, as, createOrg, expectDenied, type TestOrg } from "./support/db";

let a: TestOrg;
let b: TestOrg;

beforeAll(async () => {
  a = await createOrg("audit-a");
  b = await createOrg("audit-b");
});

describe("trigger-based audit", () => {
  it("records who changed settings, with a field-level diff", async () => {
    await as(a.users.admin, async (sql) => {
      await sql(
        "update public.organization_settings set primary_color = '#abcdef' where organization_id = $1",
        [a.id],
      );
      const { rows } = await sql(
        "select actor_type, actor_user_id, action, changes from public.audit_logs where organization_id = $1 and action = 'settings.updated'",
        [a.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_type: "user",
        actor_user_id: a.users.admin.id,
        action: "settings.updated",
        changes: { primary_color: [null, "#abcdef"] },
      });
    });
  });

  it("never copies invitation token hashes into the log", async () => {
    const { rows } = await admin(
      "select changes from public.audit_logs where organization_id = $1 and entity_type = 'organization_invitations'",
      [a.id],
    );
    await admin(
      `insert into public.organization_invitations (organization_id, email, role, token_hash, expires_at)
       values ($1, 'x@example.test', 'staff', repeat('a', 64), now() + interval '1 day')`,
      [a.id],
    );
    const after = await admin(
      "select changes from public.audit_logs where organization_id = $1 and entity_type = 'organization_invitations'",
      [a.id],
    );
    expect(after.rows.length).toBe(rows.length + 1);
    for (const row of after.rows as { changes: Record<string, unknown> }[]) {
      expect(Object.keys(row.changes)).not.toContain("token_hash");
    }
  });
});

describe("append-only", () => {
  it.each(["service", "user"] as const)("%s cannot update or delete audit rows", async (kind) => {
    const actor = kind === "service" ? ({ kind: "service" } as const) : a.users.owner;
    await as(actor, async (sql) => {
      await expectDenied(
        sql("update public.audit_logs set action = 'x.y' where organization_id = $1", [a.id]),
      );
    });
    await as(actor, async (sql) => {
      await expectDenied(sql("delete from public.audit_logs where organization_id = $1", [a.id]));
    });
  });

  it("even the table owner is blocked by the immutability trigger", async () => {
    await expectDenied(
      admin("update public.audit_logs set action = 'x.y' where organization_id = $1", [a.id]),
    );
  });

  it("users cannot insert audit rows directly", async () => {
    await as(a.users.owner, async (sql) => {
      await expectDenied(
        sql(
          "insert into public.audit_logs (organization_id, actor_type, action, entity_type) values ($1, 'system', 'x.y', 'z')",
          [a.id],
        ),
      );
    });
  });
});

describe("reading audit logs", () => {
  it("requires audit.read (office and staff see nothing)", async () => {
    for (const role of ["office", "staff"] as const) {
      const n = await as(
        a.users[role],
        async (sql) => (await sql("select count(*)::int n from public.audit_logs")).rows[0],
      );
      expect(n).toEqual({ n: 0 });
    }
    const n = await as(
      a.users.admin,
      async (sql) => (await sql("select count(*)::int n from public.audit_logs")).rows[0],
    );
    expect((n as { n: number }).n).toBeGreaterThan(0);
  });

  it("is scoped to the reader's organization", async () => {
    const orgs = await as(
      b.users.owner,
      async (sql) => (await sql("select distinct organization_id from public.audit_logs")).rows,
    );
    expect(orgs).toEqual([{ organization_id: b.id }]);
  });
});

describe("record_audit_event", () => {
  it("stamps the caller as actor", async () => {
    const id = await as(
      a.users.office,
      async (sql) =>
        (
          await sql(
            "select public.record_audit_event($1, 'quote.sent', 'quote', 'q-1', '{\"channel\":\"link\"}') as id",
            [a.id],
          )
        ).rows[0] as { id: string },
      { commit: true },
    );
    const { rows } = await admin(
      "select actor_type, actor_user_id, action, changes from public.audit_logs where id = $1",
      [id.id],
    );
    expect(rows).toEqual([
      {
        actor_type: "user",
        actor_user_id: a.users.office.id,
        action: "quote.sent",
        changes: { channel: "link" },
      },
    ]);
  });

  it("rejects writing into another organization", async () => {
    await expectDenied(
      as(b.users.owner, (sql) =>
        sql("select public.record_audit_event($1, 'quote.sent', 'quote')", [a.id]),
      ),
    );
  });

  it("rejects oversized metadata and malformed actions", async () => {
    await expectDenied(
      as(a.users.owner, (sql) =>
        sql(
          "select public.record_audit_event($1, 'quote.sent', 'quote', null, jsonb_build_object('x', repeat('y', 20000)))",
          [a.id],
        ),
      ),
      ["22023"],
    );
    await expectDenied(
      as(a.users.owner, (sql) =>
        sql("select public.record_audit_event($1, 'DROP TABLE', 'quote')", [a.id]),
      ),
      ["23514"],
    );
  });

  it("is not callable anonymously", async () => {
    await expectDenied(
      as({ kind: "anon" }, (sql) =>
        sql("select public.record_audit_event($1, 'quote.sent', 'quote')", [a.id]),
      ),
    );
  });
});
