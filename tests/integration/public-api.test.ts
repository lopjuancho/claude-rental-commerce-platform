import { beforeAll, describe, expect, it } from "vitest";
import { admin, as, createOrg, type TestOrg } from "./support/db";

let active: TestOrg;
let onboarding: TestOrg;
let suspended: TestOrg;

beforeAll(async () => {
  active = await createOrg("pub-active");
  onboarding = await createOrg("pub-onboarding", "onboarding");
  suspended = await createOrg("pub-suspended", "suspended");
  for (const org of [active, onboarding, suspended]) {
    await admin(
      "insert into public.organization_domains (organization_id, hostname, is_primary) values ($1, $2, true)",
      [org.id, `${org.slug}.example.test`],
    );
  }
  await admin(
    "update public.organization_settings set primary_color = '#111111' where organization_id = $1",
    [active.id],
  );
});

const resolve = (host: string) =>
  as(
    { kind: "anon" },
    async (sql) =>
      (await sql("select * from public.resolve_organization_by_host($1)", [host])).rows,
  );

describe("resolve_organization_by_host (anonymous tenant resolution)", () => {
  it("resolves an active organization case-insensitively", async () => {
    const rows = await resolve(`${active.slug}.EXAMPLE.test`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: active.id, slug: active.slug, primary_color: "#111111" });
  });

  it("returns only public profile fields", async () => {
    const [row] = await resolve(`${active.slug}.example.test`);
    expect(Object.keys(row as object).sort()).toEqual(
      [
        "accent_color",
        "contact_email",
        "contact_phone",
        "currency",
        "favicon_media_path",
        "id",
        "logo_mark_media_path",
        "logo_media_path",
        "name",
        "primary_color",
        "secondary_color",
        "slug",
        "sms_phone",
        "timezone",
        "website_url",
      ].sort(),
    );
  });

  it.each(["onboarding", "suspended"] as const)(
    "does not resolve %s organizations",
    async (state) => {
      const org = state === "onboarding" ? onboarding : suspended;
      expect(await resolve(`${org.slug}.example.test`)).toEqual([]);
    },
  );

  it("does not resolve unknown hosts or injection attempts", async () => {
    expect(await resolve("unknown.example.test")).toEqual([]);
    expect(await resolve("' or 1=1 --")).toEqual([]);
  });

  it("slug fallback resolves only active organizations", async () => {
    const bySlug = (slug: string) =>
      as(
        { kind: "anon" },
        async (sql) =>
          (await sql("select id from public.resolve_organization_by_slug($1)", [slug])).rows,
      );
    expect(await bySlug(active.slug)).toEqual([{ id: active.id }]);
    expect(await bySlug(suspended.slug)).toEqual([]);
  });
});
