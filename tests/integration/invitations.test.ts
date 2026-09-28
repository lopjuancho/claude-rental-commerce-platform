import { createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  as,
  createOrg,
  createUser,
  expectDenied,
  type TestOrg,
  type TestUser,
} from "./support/db";

let a: TestOrg;
let b: TestOrg;

const newToken = () => randomBytes(32).toString("base64url");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

async function invite(org: TestOrg, email: string, role = "staff", expiresInterval = "7 days") {
  const token = newToken();
  await admin(
    `insert into public.organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + $6::interval)`,
    [org.id, email, role, hash(token), org.users.owner.id, expiresInterval],
  );
  return token;
}

const accept = (user: TestUser, token: string) =>
  as(
    user,
    async (sql) =>
      (await sql("select public.accept_invitation($1) as org", [token])).rows[0] as { org: string },
  );

beforeAll(async () => {
  a = await createOrg("inv-a");
  b = await createOrg("inv-b");
});

describe("creating invitations", () => {
  const insertAs = (user: TestUser, org: TestOrg, role: string) =>
    as(user, (sql) =>
      sql(
        `insert into public.organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
         values ($1, 'new@example.test', $2, $3, $4, now() + interval '7 days')`,
        [org.id, role, hash(newToken()), user.id],
      ),
    );

  it("admins can invite non-owners", async () => {
    await expect(insertAs(a.users.admin, a, "office")).resolves.toMatchObject({ rowCount: 1 });
  });

  it("admins cannot invite owners; owners can", async () => {
    await expectDenied(insertAs(a.users.admin, a, "owner"));
    await expect(insertAs(a.users.owner, a, "owner")).resolves.toMatchObject({ rowCount: 1 });
  });

  it("office and staff cannot invite", async () => {
    await expectDenied(insertAs(a.users.office, a, "staff"));
    await expectDenied(insertAs(a.users.staff, a, "staff"));
  });

  it("cannot invite into another organization", async () => {
    await expectDenied(insertAs(b.users.owner, a, "staff"));
  });

  it("cannot forge invited_by or pre-accepted invitations", async () => {
    await expectDenied(
      as(a.users.admin, (sql) =>
        sql(
          `insert into public.organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
           values ($1, 'x@example.test', 'staff', $2, $3, now() + interval '1 day')`,
          [a.id, hash(newToken()), a.users.owner.id],
        ),
      ),
    );
  });

  it("other organizations cannot see invitations", async () => {
    await invite(a, "private@example.test");
    const rows = await as(
      b.users.owner,
      async (sql) =>
        (
          await sql("select id from public.organization_invitations where organization_id = $1", [
            a.id,
          ])
        ).rows,
    );
    expect(rows).toEqual([]);
  });
});

describe("accepting invitations", () => {
  it("adds the user with the invited role and cannot be replayed", async () => {
    const user = await createUser("invitee");
    const token = await invite(a, user.email, "office");
    await as(user, async (sql) => {
      const { rows } = await sql("select public.accept_invitation($1) as org", [token]);
      expect(rows).toEqual([{ org: a.id }]);
      const member = await sql(
        "select role from public.organization_members where organization_id = $1 and user_id = $2",
        [a.id, user.id],
      );
      expect(member.rows).toEqual([{ role: "office" }]);
      // The new member can now read their organization through RLS.
      const orgs = await sql("select id from public.organizations");
      expect(orgs.rows).toEqual([{ id: a.id }]);
      await expect(sql("select public.accept_invitation($1)", [token])).rejects.toMatchObject({
        code: "22023",
      });
    });
  });

  it("is single-use", async () => {
    const user = await createUser("reuse");
    const token = await invite(a, user.email);
    await admin(
      "update public.organization_invitations set accepted_at = now(), accepted_by = $2 where token_hash = $1",
      [hash(token), user.id],
    );
    await expectDenied(accept(user, token), ["22023"]);
  });

  it("rejects a different signed-in email", async () => {
    const intended = await createUser("intended");
    const attacker = await createUser("attacker");
    const token = await invite(a, intended.email);
    await expectDenied(accept(attacker, token), ["22023"]);
  });

  it("rejects expired invitations", async () => {
    const user = await createUser("late");
    const token = await invite(a, user.email);
    await admin(
      "update public.organization_invitations set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where token_hash = $1",
      [hash(token)],
    );
    await expectDenied(accept(user, token), ["22023"]);
  });

  it("rejects revoked invitations", async () => {
    const user = await createUser("revoked");
    const token = await invite(a, user.email);
    await admin(
      "update public.organization_invitations set revoked_at = now() where token_hash = $1",
      [hash(token)],
    );
    await expectDenied(accept(user, token), ["22023"]);
  });

  it("rejects unknown and malformed tokens", async () => {
    const user = await createUser("guess");
    await expectDenied(accept(user, newToken()), ["22023"]);
    await expectDenied(accept(user, "short"), ["22023"]);
  });

  it("an invitation email matches case-insensitively", async () => {
    const user = await createUser("case");
    const token = await invite(a, user.email.toUpperCase());
    await expect(accept(user, token)).resolves.toEqual({ org: a.id });
  });

  it("anonymous visitors cannot accept invitations", async () => {
    const token = await invite(a, "anon@example.test");
    await expectDenied(
      as({ kind: "anon" }, (sql) => sql("select public.accept_invitation($1)", [token])),
    );
  });

  it("an admin can revoke but not rewrite an invitation", async () => {
    await invite(a, "tobe-revoked@example.test");
    await as(a.users.admin, async (sql) => {
      const r = await sql(
        "update public.organization_invitations set revoked_at = now() where organization_id = $1 and email = 'tobe-revoked@example.test'",
        [a.id],
      );
      expect(r.rowCount).toBe(1);
    });
    await as(a.users.admin, async (sql) => {
      await expectDenied(
        sql(
          "update public.organization_invitations set role = 'owner' where organization_id = $1",
          [a.id],
        ),
      );
    });
  });
});
