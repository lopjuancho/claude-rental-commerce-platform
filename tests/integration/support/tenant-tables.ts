import { randomBytes, randomUUID } from "node:crypto";
import { admin, type TestOrg } from "./db";

/**
 * Every table in the public schema must be classified here. The RLS coverage test fails when a
 * migration adds a table that is not listed, forcing an explicit isolation decision + fixture.
 */
const batchCache = new Map<string, Promise<string>>();
function ensureImportBatch(org: TestOrg): Promise<string> {
  let entry = batchCache.get(org.id);
  if (!entry) {
    entry = admin<{ id: string }>(
      `insert into public.import_batches (organization_id, adapter_id, external_source, headers, row_count)
       values ($1, 'generic_csv', 'csv', '{Name}', 1) returning id`,
      [org.id],
    ).then((r) => r.rows[0]!.id);
    batchCache.set(org.id, entry);
  }
  return entry;
}

export const GLOBAL_TABLES = ["role_permissions"] as const;

/** Tables keyed to a user rather than an organization; covered by dedicated tests. */
export const USER_TABLES = ["user_profiles"] as const;

/** Views deliberately readable by anonymous visitors (published catalog data only). */
export const PUBLIC_VIEWS = [
  "public_catalog_categories",
  "public_catalog_product_media",
  "public_catalog_products",
] as const;

/** Creates a category + product (with its default variant) and returns their ids. Idempotent per org. */
const catalogCache = new Map<
  string,
  Promise<{ categoryId: string; productId: string; variantId: string; product2Id: string }>
>();
export function ensureCatalog(org: TestOrg) {
  let entry = catalogCache.get(org.id);
  if (!entry) {
    entry = (async () => {
      const cat = await admin<{ id: string }>(
        "insert into public.categories (organization_id, name, slug) values ($1, 'Bounce Houses', 'bounce-houses') returning id",
        [org.id],
      );
      const categoryId = cat.rows[0]!.id;
      const prod = await admin<{ id: string }>(
        `insert into public.products (organization_id, name, slug, base_price_cents, primary_category_id, internal_notes)
         values ($1, 'Castle', 'castle', 20000, $2, 'secret margin') returning id`,
        [org.id, categoryId],
      );
      const productId = prod.rows[0]!.id;
      const prod2 = await admin<{ id: string }>(
        "insert into public.products (organization_id, name, slug, base_price_cents) values ($1, 'Generator', 'generator', 5000) returning id",
        [org.id],
      );
      const variant = await admin<{ id: string }>(
        "select id from public.product_variants where product_id = $1",
        [productId],
      );
      return {
        categoryId,
        productId,
        variantId: variant.rows[0]!.id,
        product2Id: prod2.rows[0]!.id,
      };
    })();
    catalogCache.set(org.id, entry);
  }
  return entry;
}

/** Tenant-owned tables → the column holding the organization id, and a fixture that guarantees a row exists. */
export const TENANT_TABLES: Record<
  string,
  { orgColumn: string; ensureRow: (org: TestOrg) => Promise<void> }
> = {
  organizations: { orgColumn: "id", ensureRow: () => Promise.resolve() },
  organization_settings: { orgColumn: "organization_id", ensureRow: () => Promise.resolve() },
  organization_members: { orgColumn: "organization_id", ensureRow: () => Promise.resolve() },
  audit_logs: { orgColumn: "organization_id", ensureRow: () => Promise.resolve() }, // written by member triggers
  organization_domains: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        "insert into public.organization_domains (organization_id, hostname) values ($1, $2)",
        [org.id, `${org.slug}.example.test`],
      );
    },
  },
  organization_policies: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        "insert into public.organization_policies (organization_id, policy_type, title, body) values ($1, 'other', 'T', 'B')",
        [org.id],
      );
    },
  },
  categories: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureCatalog(org);
    },
  },
  products: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureCatalog(org);
    },
  },
  product_variants: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureCatalog(org);
    },
  },
  product_categories: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const c = await ensureCatalog(org);
      await admin(
        "insert into public.product_categories (organization_id, product_id, category_id) values ($1, $2, $3) on conflict do nothing",
        [org.id, c.productId, c.categoryId],
      );
    },
  },
  inventory_units: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const c = await ensureCatalog(org);
      await admin(
        "insert into public.inventory_units (organization_id, variant_id, label) values ($1, $2, 'Unit 1')",
        [org.id, c.variantId],
      );
    },
  },
  product_media: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const c = await ensureCatalog(org);
      await admin(
        "insert into public.product_media (organization_id, product_id, storage_path, source) values ($1, $2, $3, 'upload')",
        [org.id, c.productId, `${org.id}/products/${c.productId}/a.jpg`],
      );
    },
  },
  product_relations: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const c = await ensureCatalog(org);
      await admin(
        "insert into public.product_relations (organization_id, product_id, related_product_id, relation_type) values ($1, $2, $3, 'addon')",
        [org.id, c.productId, c.product2Id],
      );
    },
  },
  import_mapping_presets: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        "insert into public.import_mapping_presets (organization_id, adapter_id, name, mapping) values ($1, 'generic_csv', 'Default', '{}')",
        [org.id],
      );
    },
  },
  import_batches: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureImportBatch(org);
    },
  },
  import_rows: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const batchId = await ensureImportBatch(org);
      await admin(
        `insert into public.import_rows (organization_id, batch_id, row_number, raw)
         values ($1, $2, 1, '{"Name":"Castle"}') on conflict do nothing`,
        [org.id, batchId],
      );
    },
  },
  weather_hazard_rules: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const c = await ensureCatalog(org);
      await admin(
        "insert into public.weather_hazard_rules (organization_id, category_id, hazard, sensitive, threshold_value, threshold_unit) values ($1, $2, 'wind', true, 15, 'mph') on conflict do nothing",
        [org.id, c.categoryId],
      );
    },
  },
  organization_invitations: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        `insert into public.organization_invitations (organization_id, email, role, token_hash, expires_at)
         values ($1, $2, 'staff', $3, now() + interval '1 day')`,
        [
          org.id,
          `invitee-${randomUUID().slice(0, 8)}@example.test`,
          randomBytes(32).toString("hex"),
        ],
      );
    },
  },
};
