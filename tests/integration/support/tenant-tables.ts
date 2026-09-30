import { createHash, randomBytes, randomUUID } from "node:crypto";
import { admin, type TestOrg } from "./db";
import { rpc, SYSTEM } from "./availability";

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

const reservationCache = new Map<string, Promise<string>>();
function ensureReservation(org: TestOrg): Promise<string> {
  let entry = reservationCache.get(org.id);
  if (!entry) {
    entry = (async () => {
      const c = await ensureCatalog(org);
      const r = await admin<{ id: string }>(
        "insert into public.reservations (organization_id, source, status) values ($1, 'manual', 'confirmed') returning id",
        [org.id],
      );
      await admin(
        `insert into public.reservation_allocations (organization_id, reservation_id, variant_id, quantity, rental_period, occupied_period, status)
         values ($1, $2, $3, 1, tstzrange('2030-03-01 12:00Z', '2030-03-01 16:00Z'), tstzrange('2030-03-01 11:00Z', '2030-03-01 17:00Z'), 'confirmed')`,
        [org.id, r.rows[0]!.id, c.variantId],
      );
      return r.rows[0]!.id;
    })();
    reservationCache.set(org.id, entry);
  }
  return entry;
}

const quoteCache = new Map<string, Promise<string>>();
function ensureQuote(org: TestOrg): Promise<string> {
  let entry = quoteCache.get(org.id);
  if (!entry) {
    entry = (async () => {
      const c = await ensureCatalog(org);
      const customer = await admin<{ id: string }>(
        "insert into public.customers (organization_id, email) values ($1, $2) returning id",
        [org.id, `fixture-${randomUUID().slice(0, 8)}@example.test`],
      );
      const event = await admin<{ id: string }>(
        "insert into public.events (organization_id, customer_id, title) values ($1, $2, 'Fixture party') returning id",
        [org.id, customer.rows[0]!.id],
      );
      const input = {
        items: [
          {
            lineId: "L1",
            variantId: c.variantId,
            productId: c.productId,
            name: "Castle",
            kind: "rental",
            quantity: 1,
            basePriceCents: 20000,
            start: "2030-05-01T12:00:00.000Z",
            end: "2030-05-01T16:00:00.000Z",
          },
        ],
      };
      const output = {
        currency: "USD",
        lines: [{ lineId: "L1", kind: "base", amountCents: 20000 }],
        summary: { subtotal: 20000, delivery: 0, discounts: 0, tax: 0, total: 20000 },
        reviewReasons: [],
      };
      const calc = await admin<{ id: string }>(
        `insert into public.pricing_calculations (organization_id, engine_version, input, output, input_hash, currency, total_cents, manual_review_required, created_by_type)
         values ($1, 'test', $2, $3, repeat('c', 64), 'USD', 20000, false, 'system') returning id`,
        [org.id, JSON.stringify(input), JSON.stringify(output)],
      );
      const quote = await admin<{ id: string }>(
        "insert into public.quotes (organization_id, customer_id, event_id, pricing_calculation_id) values ($1, $2, $3, $4) returning id",
        [org.id, customer.rows[0]!.id, event.rows[0]!.id, calc.rows[0]!.id],
      );
      const reservation = await ensureReservation(org);
      await admin(
        `insert into public.booking_requests (organization_id, quote_id, customer_id, event_id, source, reservation_id, created_by_type)
         values ($1, $2, $3, $4, 'web', $5, 'public')`,
        [org.id, quote.rows[0]!.id, customer.rows[0]!.id, event.rows[0]!.id, reservation],
      );
      return quote.rows[0]!.id;
    })();
    quoteCache.set(org.id, entry);
  }
  return entry;
}

const weatherCache = new Map<string, Promise<string>>();
function ensureWeatherBlock(org: TestOrg): Promise<string> {
  let entry = weatherCache.get(org.id);
  if (!entry) {
    entry = admin<{ id: string }>(
      "insert into public.weather_blocks (organization_id, hazard, period, reason) values ($1, 'wind', tstzrange('2030-04-01', '2030-04-02'), 'test') returning id",
      [org.id],
    ).then((r) => r.rows[0]!.id);
    weatherCache.set(org.id, entry);
  }
  return entry;
}

const areaCache = new Map<string, Promise<string>>();
function ensureServiceArea(org: TestOrg): Promise<string> {
  let entry = areaCache.get(org.id);
  if (!entry) {
    entry = admin<{ id: string }>(
      "insert into public.service_areas (organization_id, name) values ($1, 'Metro') returning id",
      [org.id],
    ).then((r) => r.rows[0]!.id);
    areaCache.set(org.id, entry);
  }
  return entry;
}

const jurisdictionCache = new Map<string, Promise<string>>();
function ensureJurisdiction(org: TestOrg): Promise<string> {
  let entry = jurisdictionCache.get(org.id);
  if (!entry) {
    entry = admin<{ id: string }>(
      "insert into public.tax_jurisdictions (organization_id, name, state) values ($1, 'Test TN', 'TN') returning id",
      [org.id],
    ).then((r) => r.rows[0]!.id);
    jurisdictionCache.set(org.id, entry);
  }
  return entry;
}

export const GLOBAL_TABLES = ["role_permissions"] as const;

/** Tables keyed to a user rather than an organization; covered by dedicated tests. */
export const USER_TABLES = ["user_profiles"] as const;

/** Views deliberately readable by anonymous visitors (published catalog data only). */
export const PUBLIC_VIEWS = [
  "public_catalog_categories",
  "public_catalog_category_summaries",
  "public_catalog_event_types",
  "public_catalog_product_media",
  "public_catalog_products",
  "public_catalog_variants",
  "public_service_areas",
  "public_storefront_domains",
  "public_storefront_policies",
  "public_storefront_settings",
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
  availability_blocks: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const c = await ensureCatalog(org);
      await admin(
        "insert into public.availability_blocks (organization_id, product_id, period, reason) values ($1, $2, tstzrange('2030-01-01', '2030-01-02'), 'maintenance')",
        [org.id, c.productId],
      );
    },
  },
  reservations: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureReservation(org);
    },
  },
  reservation_allocations: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureReservation(org);
    },
  },
  reservation_flags: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const rid = await ensureReservation(org);
      const c = await ensureCatalog(org);
      await admin(
        `with b as (insert into public.availability_blocks (organization_id, product_id, period, reason)
                    values ($1, $2, tstzrange('2030-02-01', '2030-02-02'), 'other') returning id)
         insert into public.reservation_flags (organization_id, reservation_id, kind, availability_block_id, message)
         select $1, $3, 'availability_block', b.id, 'test' from b on conflict do nothing`,
        [org.id, c.productId, rid],
      );
    },
  },
  weather_blocks: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureWeatherBlock(org);
    },
  },
  weather_block_targets: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const w = await ensureWeatherBlock(org);
      const c = await ensureCatalog(org);
      await admin(
        "insert into public.weather_block_targets (organization_id, weather_block_id, product_id) values ($1, $2, $3) on conflict do nothing",
        [org.id, w, c.productId],
      );
    },
  },
  pricing_rules: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        "insert into public.pricing_rules (organization_id, name, rule_type, params) values ($1, 'Additional day', 'additional_day', '{\"percent_of_base_bps\": 2500}') on conflict do nothing",
        [org.id],
      );
    },
  },
  service_areas: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureServiceArea(org);
    },
  },
  service_area_rules: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const area = await ensureServiceArea(org);
      await admin(
        "insert into public.service_area_rules (organization_id, service_area_id, rule_type, postal_code) values ($1, $2, 'postal_code', '38127')",
        [org.id, area],
      );
    },
  },
  tax_jurisdictions: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureJurisdiction(org);
    },
  },
  tax_rates: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const j = await ensureJurisdiction(org);
      await admin(
        "insert into public.tax_rates (organization_id, jurisdiction_id, name, rate_bps) values ($1, $2, 'Test rate', 900)",
        [org.id, j],
      );
    },
  },
  tax_component_rules: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const j = await ensureJurisdiction(org);
      await admin(
        "insert into public.tax_component_rules (organization_id, jurisdiction_id, component, taxable) values ($1, $2, 'rental', true) on conflict do nothing",
        [org.id, j],
      );
    },
  },
  delivery_distance_cache: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        "insert into public.delivery_distance_cache (organization_id, provider, provider_version, route_key, meters, expires_at) values ($1, 'fake', '1', repeat('a', 64), 1000, now() + interval '1 day') on conflict do nothing",
        [org.id],
      );
    },
  },
  pricing_calculations: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        `insert into public.pricing_calculations (organization_id, engine_version, input, output, input_hash, currency, total_cents, manual_review_required, created_by_type)
         values ($1, 'test', '{}', '{}', repeat('b', 64), 'USD', 0, false, 'system')`,
        [org.id],
      );
    },
  },
  customers: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureQuote(org);
    },
  },
  events: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureQuote(org);
    },
  },
  quote_counters: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureQuote(org);
    },
  },
  quotes: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureQuote(org);
    },
  },
  quote_items: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureQuote(org);
    },
  },
  quote_hold_budgets: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      const quote = await ensureQuote(org);
      await admin(
        "insert into public.quote_hold_budgets (organization_id, quote_id, revision, used) values ($1, $2, 1, 1) on conflict do nothing",
        [org.id, quote],
      );
    },
  },
  booking_requests: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await ensureQuote(org);
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
  // M7 assistant (ADR 0017): written only through the service-role functions.
  ai_conversations: { orgColumn: "organization_id", ensureRow: ensureAiConversation },
  ai_messages: { orgColumn: "organization_id", ensureRow: ensureAiConversation },
  ai_actions: { orgColumn: "organization_id", ensureRow: ensureAiConversation },
  ai_turns: { orgColumn: "organization_id", ensureRow: ensureAiConversation },
  ai_mutations: { orgColumn: "organization_id", ensureRow: ensureAiConversation },
};

/**
 * One conversation with a completed turn (message), a committed journal entry and a telemetry row,
 * created through the same service-role functions the server uses.
 */
async function ensureAiConversation(org: TestOrg): Promise<void> {
  const hash = createHash("sha256").update(`fixture:${org.id}`).digest("hex");
  const [t] = await rpc<{
    outcome: string;
    turn_id: string;
    attempt: number;
    conversation_id: string;
  }>(SYSTEM, "select * from public.ai_turn_begin($1, $2, 'fixture-request', 60, null)", [
    org.id,
    hash,
  ]);
  if (t!.outcome !== "started") return;
  const [m] = await rpc<{ mutation_id: string }>(
    SYSTEM,
    "select * from public.ai_mutation_begin($1, $2, $3, $4, 'create_quote', 'fixture', null)",
    [org.id, t!.turn_id, t!.attempt, "f".repeat(64)],
  );
  await rpc(SYSTEM, "select public.ai_mutation_commit($1, $2, '{}'::jsonb, '{}'::jsonb)", [
    org.id,
    m!.mutation_id,
  ]);
  await rpc(
    SYSTEM,
    "select public.ai_turn_finish($1, $2, $3, '{}'::jsonb, null, $4::jsonb, 0, 0, 'fixture', 0, '{}'::jsonb)",
    [org.id, t!.turn_id, t!.attempt, JSON.stringify([{ role: "user", content: "hello" }])],
  );
  await rpc(
    SYSTEM,
    "select public.ai_action_record($1, $2, 'search_products', 'ok', null, 1, null, null)",
    [org.id, t!.conversation_id],
  );
}
