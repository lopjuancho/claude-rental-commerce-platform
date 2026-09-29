# Database Design

> Status: **Accepted for Phase 1** (updated 2026-09-28 with ADRs 0001–0006). SQL below is a design sketch; the authoritative version will be the files in `supabase/migrations/` created in Milestones 1–5.
> See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the surrounding system.

## 1. Conventions

| Convention | Rule | Why |
|---|---|---|
| Primary keys | `id uuid default gen_random_uuid()` | Non-enumerable, safe in URLs, mergeable across environments. |
| Tenant key | `organization_id uuid not null` on **every** tenant-owned table, including children | RLS becomes a single indexed predicate per table; no joins in policies. |
| Tenant-safe FKs | Parents declare `unique (organization_id, id)`; children reference `(organization_id, parent_id)` | The DB itself rejects cross-tenant references. |
| Money | `bigint` minor units, column suffix `_cents`; currency on the organization | No floating-point errors. |
| Rates | `integer` basis points, suffix `_bps` (975 = 9.75%) | Exact percentage arithmetic. |
| Time | `timestamptz` for instants; `tstzrange` `[)` for periods; `organizations.timezone` (IANA) for local interpretation | Correct DST behavior; half-open ranges allow back-to-back bookings. |
| Durations | `integer` minutes, suffix `_minutes` | Simple arithmetic, no `interval` ambiguity. |
| Enums | PostgreSQL enums for closed, code-coupled sets (status, role); lookup tables for tenant-editable sets | Enums are cheap to extend (`alter type … add value`). |
| Timestamps | `created_at`, `updated_at` (trigger-maintained) on all mutable tables | |
| Soft delete | `archived_at timestamptz` on catalog/customer entities; quotes/reservations use status | Historical quotes must keep referencing archived products. |
| Naming | snake_case, plural table names | |
| Schemas | `public` (tables exposed via PostgREST under RLS), `app` (helper functions, not exposed), `private` (system-only tables if needed) | Keeps helpers out of the API surface. |
| Extensions | `pgcrypto`, `btree_gist`, `pg_trgm`, `citext` | Exclusion constraints, fuzzy search, case-insensitive email. |

## 2. Entity overview

```
organizations ─┬─ organization_domains
               ├─ organization_settings (1:1)  branding, contact, operational defaults
               ├─ organization_policies        versioned public policies
               ├─ organization_members ── auth.users ── user_profiles
               ├─ organization_invitations
               ├─ categories ── product_categories ── products ─┬─ product_variants ─┬─ inventory_units
               │                                                ├─ product_media     └─ (pooled_quantity)
               │                                                └─ product_relations (add-ons)
               ├─ availability_rules
               ├─ availability_blocks            (org / product / variant / unit scope)
               ├─ reservations ── reservation_allocations   (the ONLY consumer of inventory)
               ├─ service_areas ── service_area_rules      (postal_code / city / mileage)
               ├─ pricing_rules
               ├─ tax_jurisdictions ─┬─ tax_rates
               │                     └─ tax_component_rules
               ├─ import_batches ── import_rows
               ├─ customers ── events ── quotes ─┬─ quote_items
               │                                 ├─ quote_charges
               │                                 └─ booking_requests ── reservations (held → confirmed)
               ├─ conversations ── conversation_messages
               │                └─ ai_actions
               ├─ organization_counters         (quote numbers)
               └─ audit_logs
 global:  role_permissions
```

### Changes from the initial table list, and why

- `organization_users` → **`organization_members`** (membership with role) — clearer, and allows invitation/suspension status.
- `business_settings` → **`organization_settings`** (1:1, branding + contact + defaults) + **`organization_policies`** (many, versioned). Policies are content the AI quotes verbatim, so they need versioning and publish state; settings are scalar config.
- **`organization_domains`** added for host-based tenant resolution.
- **`product_categories`** join table added: a combo can be both "Bounce Houses" and "Water Slides".
- **`product_relations`** added as the seam for add-ons/accessories ("generator", "extra slide lane").
- `reservations` split into **`reservations`** (header: why inventory is taken — a quote, a manual block for a staff booking, later an order) and **`reservation_allocations`** (what is taken: unit or pooled quantity, and when). Allocations are what the availability engine counts and what the exclusion constraint protects.
- **`quote_charges`** added next to `quote_items`: delivery, discounts, fees, taxes and manual adjustments are not products and should not be fake quote items.
- **`tax_jurisdictions` / `tax_rates` / `tax_component_rules`** separated from `pricing_rules` — tax is legally distinct, location-based, and taxability differs per component (ADR 0004).
- **`booking_requests`** added — the "checkout started" state that owns a temporary 15-minute hold (ADR 0002).
- **`import_batches` / `import_rows`** added — staged CSV import with preview/mapping/validation (ADR 0006).
- **`service_area_rules`** separated from `service_areas` so one zone can match many ZIPs/cities, and future radius/mileage rules are new rule types.
- **`role_permissions`** (global) added so authorization checks permissions, not role names.
- **`organization_counters`** added for gap-tolerant, per-tenant sequential quote numbers.
- **`orders`** intentionally **not** created in Phase 1 (no payments/contracts). Accepted quote + confirmed reservation covers Phase 1; `orders` will be introduced with payments and will take ownership of reservations.

## 3. Tenancy, identity, access

```sql
create type org_status as enum ('active','suspended','onboarding','closed');
create type org_role   as enum ('owner','admin','office','staff');   -- later: 'driver','warehouse'

create table organizations (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9](-?[a-z0-9])*$'),
  name          text not null,                  -- display name: "Tiky Jumps"
  legal_name    text,                           -- "Tiky Jumps Inflatables LLC"
  status        org_status not null default 'onboarding',
  timezone      text not null,                  -- IANA, e.g. 'America/Chicago'
  currency      char(3) not null default 'USD',
  country_code  char(2) not null default 'US',
  plan          text,                           -- SaaS plan seam
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table organization_domains (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  hostname         citext not null unique,      -- 'tikyjumps.com', 'tiky-jumps.<platform>'
  is_primary       boolean not null default false,
  verified_at      timestamptz
);

create table organization_settings (             -- 1:1 with organizations
  organization_id       uuid primary key references organizations(id) on delete cascade,
  -- branding
  logo_media_path       text,
  primary_color         text check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  secondary_color       text check (secondary_color ~ '^#[0-9a-fA-F]{6}$'),
  -- contact
  contact_phone         text,
  sms_phone             text,
  contact_email         citext,
  website_url           text,
  address_line1 text, city text, state text, postal_code text,
  -- operational defaults
  -- operational defaults: the "org" level of the override chain (ADR 0003)
  default_setup_buffer_minutes     integer not null default 60  check (default_setup_buffer_minutes >= 0),
  default_teardown_buffer_minutes  integer not null default 60  check (default_teardown_buffer_minutes >= 0),
  default_event_start_time         time    not null default '10:00',
  default_rental_duration_minutes  integer not null default 360 check (default_rental_duration_minutes > 0),
  min_booking_lead_time_minutes    integer not null default 720 check (min_booking_lead_time_minutes >= 0),  -- 12 h
  overnight_allowed                boolean not null default false,
  wind_threshold_mph               smallint check (wind_threshold_mph > 0),  -- ADR 0010; Tiky Jumps: 15
  quote_valid_days                 integer not null default 7   check (quote_valid_days > 0),
  booking_hold_minutes             integer not null default 15  check (booking_hold_minutes between 1 and 1440),  -- ADR 0002
  -- road-distance delivery (ADR 0009); multiple depots later via organization_depots
  primary_depot_address_line1 text, primary_depot_city text, primary_depot_state text, primary_depot_postal_code text,
  primary_depot_latitude numeric(9,6), primary_depot_longitude numeric(9,6),
  free_delivery_miles      numeric(6,2) check (free_delivery_miles >= 0),          -- 5
  per_mile_rate_cents      bigint check (per_mile_rate_cents >= 0),                -- 400
  maximum_delivery_miles   numeric(6,2) check (maximum_delivery_miles > 0),        -- null = no maximum
  mileage_rounding_method  mileage_rounding not null default 'ceil_whole_mile',    -- ceil_whole_mile | round_whole_mile | none
  mileage_basis            mileage_basis not null default 'one_way',               -- one_way | round_trip
  -- assistant
  assistant_enabled      boolean not null default false,
  assistant_display_name text,
  assistant_greeting     text,
  updated_at             timestamptz not null default now()
);

create table organization_policies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  policy_type      text not null,   -- 'cancellation','weather','deposit','delivery','safety','other'
  title            text not null,
  body             text not null,
  version          integer not null default 1,
  is_published     boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table user_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  phone       text,
  avatar_path text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table organization_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            org_role not null,
  status          text not null default 'active' check (status in ('active','suspended')),
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index on organization_members (user_id);

create table organization_invitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  email            citext not null,
  role             org_role not null,
  token_hash       text not null unique,       -- store only a hash of the token
  invited_by       uuid references auth.users(id),
  expires_at       timestamptz not null,
  accepted_at      timestamptz
);

create table role_permissions (                  -- global, seeded by migration
  role        org_role not null,
  permission  text not null,                     -- 'catalog.read','catalog.write','quotes.write',...
  primary key (role, permission)
);
```

**Initial permission matrix** (seeded):

| Permission | owner | admin | office | staff |
|---|:-:|:-:|:-:|:-:|
| `org.read` (dashboard, catalog, calendar) | ✓ | ✓ | ✓ | ✓ |
| `catalog.write` (products, categories, media, inventory) | ✓ | ✓ | ✓ | |
| `availability.write` (blocks, reservations) | ✓ | ✓ | ✓ | |
| `customers.read` / `customers.write` | ✓ | ✓ | ✓ | read |
| `events.write`, `quotes.write` | ✓ | ✓ | ✓ | |
| `conversations.read` | ✓ | ✓ | ✓ | |
| `pricing.write` (rules, tax, service areas) | ✓ | ✓ | | |
| `settings.write` (branding, policies, defaults) | ✓ | ✓ | | |
| `members.manage` | ✓ | ✓ (not owner role) | | |
| `audit.read` | ✓ | ✓ | | |
| `org.delete` / ownership transfer | ✓ | | | |

(Exact matrix to be confirmed with Tiky Jumps; changing it is a data migration.)

## 4. Catalog

```sql
create type pricing_type    as enum ('per_event','hourly','daily','per_unit');
create type tracking_mode   as enum ('serialized','pooled');
create type event_type      as enum ('birthday','school','church','corporate','community',
                                     'graduation','festival','wedding','sports','holiday','other');
create type media_kind      as enum ('image','video');

create table categories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  parent_id        uuid,
  name             text not null,
  slug             text not null,
  description      text,
  sort_order       integer not null default 0,
  is_published     boolean not null default true,
  -- "category" level of the override chain (ADR 0003); null = inherit from org
  setup_buffer_minutes        integer check (setup_buffer_minutes >= 0),
  teardown_buffer_minutes     integer check (teardown_buffer_minutes >= 0),
  included_duration_minutes   integer check (included_duration_minutes > 0),   -- Water Slides: 240
  overnight_allowed           boolean,
  wind_sensitive              boolean,                                          -- ADR 0010; null = not sensitive
  wind_threshold_mph          smallint check (wind_threshold_mph > 0),
  archived_at      timestamptz,
  unique (organization_id, id),
  unique (organization_id, slug),
  foreign key (organization_id, parent_id) references categories(organization_id, id)
);

create table products (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references organizations(id) on delete cascade,
  primary_category_id       uuid,
  name                      text not null,
  slug                      text not null,
  short_description         text,
  description               text,
  -- merchandising
  is_published              boolean not null default false,
  is_featured               boolean not null default false,
  sort_order                integer not null default 0,
  -- pricing headline (detailed rules in pricing_rules)
  pricing_type              pricing_type not null default 'per_event',
  base_price_cents          bigint not null check (base_price_cents >= 0),
  included_duration_minutes integer check (included_duration_minutes > 0),   -- null = inherit (category → org)
  minimum_rental_minutes    integer check (minimum_rental_minutes > 0),
  -- "product" level of the override chain (ADR 0003); null = inherit
  setup_buffer_minutes      integer check (setup_buffer_minutes >= 0),
  teardown_buffer_minutes   integer check (teardown_buffer_minutes >= 0),
  min_booking_lead_time_minutes integer check (min_booking_lead_time_minutes >= 0),
  overnight_allowed         boolean,
  wind_sensitive            boolean,                                          -- null = inherit from category (ADR 0010)
  wind_threshold_mph        smallint check (wind_threshold_mph > 0),          -- null = inherit
  -- suitability (AI-searchable, typed)
  wet_allowed               boolean not null default false,
  dry_allowed               boolean not null default true,
  minimum_age               smallint check (minimum_age >= 0),
  maximum_age               smallint check (maximum_age >= minimum_age),
  recommended_capacity      smallint check (recommended_capacity > 0),       -- simultaneous riders
  max_rider_weight_lbs      smallint,
  ideal_event_types         event_type[] not null default '{}',
  indoor_allowed            boolean not null default false,
  outdoor_allowed           boolean not null default true,
  allowed_surfaces          text[] not null default '{}',                      -- 'grass','concrete','asphalt','indoor_floor'
  -- physical requirements (feet / minutes)
  space_length_ft           numeric(5,1) check (space_length_ft > 0),
  space_width_ft            numeric(5,1) check (space_width_ft > 0),
  space_height_ft           numeric(5,1) check (space_height_ft > 0),
  power_outlets_required    smallint check (power_outlets_required >= 0),
  power_notes               text,                                             -- e.g. "1 dedicated 20A circuit within 50 ft"
  water_required            boolean not null default false,
  operator_required         boolean not null default false,
  attendants_required       smallint not null default 0 check (attendants_required >= 0),
  setup_requirements        text,                                             -- customer-facing, e.g. "flat grass, no slope"
  anchoring_methods         text[] not null default '{}',                      -- 'stakes','sandbags','water_barrels'
  setup_minutes             integer check (setup_minutes >= 0),
  teardown_minutes          integer check (teardown_minutes >= 0),
  -- discovery
  tags                      text[] not null default '{}',                     -- lower-case, normalized
  extra_specs               jsonb not null default '{}'::jsonb,               -- display-only, never used for claims
  search_vector             tsvector generated always as (…) stored,          -- name/short_description/tags
  -- internal
  internal_notes            text,                                             -- NEVER exposed publicly or to AI
  external_source           text,                                             -- 'ers','csv' (ADR 0006)
  external_ref              text,                                             -- source system id for idempotent re-import
  archived_at               timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, slug),
  check (wet_allowed or dry_allowed),
  unique (organization_id, external_source, external_ref),
  foreign key (organization_id, primary_category_id) references categories(organization_id, id)
);
create index on products using gin (tags);
create index on products using gin (search_vector);
create index on products using gin (name gin_trgm_ops);

create table product_categories (
  organization_id uuid not null,
  product_id      uuid not null,
  category_id     uuid not null,
  primary key (product_id, category_id),
  foreign key (organization_id, product_id)  references products(organization_id, id)  on delete cascade,
  foreign key (organization_id, category_id) references categories(organization_id, id) on delete cascade
);

create table product_variants (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null,
  product_id                  uuid not null,
  name                        text not null default 'Default',
  sku                         text,
  is_default                  boolean not null default false,
  price_override_cents        bigint check (price_override_cents >= 0),
  tracking_mode               tracking_mode not null default 'serialized',
  pooled_quantity             integer check (pooled_quantity >= 0),          -- only for pooled
  setup_buffer_minutes        integer,                                       -- null → org default
  teardown_buffer_minutes     integer,
  is_active                   boolean not null default true,
  archived_at                 timestamptz,
  unique (organization_id, id),
  unique (organization_id, sku),
  foreign key (organization_id, product_id) references products(organization_id, id) on delete cascade,
  check ((tracking_mode = 'pooled') = (pooled_quantity is not null))
);
create unique index one_default_variant on product_variants (product_id) where is_default;

create table inventory_units (                                -- serialized variants only
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  variant_id       uuid not null,
  label            text not null,                            -- "Unit #2", serial, internal name
  status           text not null default 'active' check (status in ('active','retired')),
  condition_notes  text,
  acquired_on      date,
  unique (organization_id, id),
  foreign key (organization_id, variant_id) references product_variants(organization_id, id)
);

create table product_media (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  product_id       uuid not null,
  kind             media_kind not null default 'image',
  storage_provider text not null default 'supabase',        -- seam for R2 migration
  storage_path     text not null,                           -- '{organization_id}/products/{product_id}/{file}'
  alt_text         text,
  width integer, height integer,
  sort_order       integer not null default 0,
  is_primary       boolean not null default false,
  -- ownership & rights (ADR 0006)
  uploaded_by      uuid references auth.users(id),
  source           text not null check (source in ('upload','import','supplier')),
  original_filename text,
  rights_status    text not null default 'unverified'
                     check (rights_status in ('owned','licensed','supplier_permitted','unverified')),
  rights_notes     text,
  created_at       timestamptz not null default now(),
  foreign key (organization_id, product_id) references products(organization_id, id) on delete cascade
);

create table product_relations (                             -- add-ons / accessories / requirements
  organization_id    uuid not null,
  product_id         uuid not null,
  related_product_id uuid not null,
  relation_type      text not null check (relation_type in ('addon','recommended','requires')),
  primary key (product_id, related_product_id, relation_type),
  foreign key (organization_id, product_id)         references products(organization_id, id) on delete cascade,
  foreign key (organization_id, related_product_id) references products(organization_id, id) on delete cascade
);
```

**Relational vs JSONB reasoning.** Anything the assistant filters on or makes a claim about (capacity, ages, wet/dry, dimensions, power, water, operator, event types, surfaces) is a typed column with `CHECK` constraints — this is what lets `search_products` be precise and lets the grounding validator verify that a cited attribute exists. `extra_specs` JSONB exists only for display-only oddities (e.g. "number of basketball hoops") and the assistant is instructed/validated not to rely on it for suitability claims. `tags` and `ideal_event_types` are arrays (not join tables) because they are small, filter-only, and GIN-indexable; tags will move to a table if tenants need managed tag vocabularies.

**Media rights:** public catalog views only expose media with `rights_status <> 'unverified'`. Storage paths are always prefixed with the owning `organization_id`; media is never copied between organizations.

**Override chain (ADR 0003):** `null` in a variant/product/category override column means "inherit". Resolution is implemented once in `src/domain/config/resolve.ts` and, for buffers, in the SQL function `app.resolve_buffers(variant_id)` used by `reserve_inventory`.

**Quantity** is not a column on `products`: it is derived — count of active `inventory_units` for serialized variants, or `pooled_quantity` for pooled ones. A generated `product_inventory_summary` view exposes it for admin and search.

## 5. Availability rules & blocks

```sql
create type block_reason as enum ('blackout','maintenance','repair','private_use','other');

create table availability_blocks (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  -- scope: exactly one of these is set, or none = whole organization
  product_id         uuid,
  variant_id         uuid,
  inventory_unit_id  uuid,
  period             tstzrange not null check (not isempty(period)),
  reason             block_reason not null,
  quantity           integer check (quantity > 0),   -- pooled partial blocks (e.g. 20 chairs damaged)
  notes              text,
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  check (num_nonnulls(product_id, variant_id, inventory_unit_id) <= 1),
  foreign key (organization_id, product_id)        references products(organization_id, id),
  foreign key (organization_id, variant_id)        references product_variants(organization_id, id),
  foreign key (organization_id, inventory_unit_id) references inventory_units(organization_id, id)
);
create index on availability_blocks using gist (organization_id, period);

create table availability_rules (                  -- declarative constraints, Zod-validated params
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  product_id       uuid,                          -- null = org-wide
  rule_type        text not null check (rule_type in
                     ('min_lead_time','closed_weekdays','booking_window_days','max_events_per_day')),
  params           jsonb not null,                -- e.g. {"weekdays":[0]} ; validated in app + CHECK on jsonb shape
  is_active        boolean not null default true,
  foreign key (organization_id, product_id) references products(organization_id, id)
);
```

### 5.1 Weather blocks (ADR 0010, M3)

```sql
create type weather_block_status as enum ('proposed','confirmed','lifted');

create table weather_blocks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  period           tstzrange not null check (not isempty(period)),
  status           weather_block_status not null default 'proposed',
  source           text not null check (source in ('staff','weather_api')),
  reason           text not null,
  wind_mph         smallint,                       -- observed/forecast, informational
  applies_to_all_wind_sensitive boolean not null default true,
  created_by uuid, confirmed_by uuid, confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create table weather_block_categories (organization_id uuid, weather_block_id uuid, category_id uuid, …);  -- composite FKs
create table weather_block_products   (organization_id uuid, weather_block_id uuid, product_id uuid, …);
```

Only `confirmed` blocks make wind-sensitive products unavailable (`WEATHER_BLOCK`). `proposed` blocks (e.g. from a weather API) only warn. Overlapping reservations get a review flag; nothing is cancelled automatically.

## 6. Reservations & the availability engine

```sql
create type reservation_status as enum ('held','confirmed','released','cancelled','completed');
create type reservation_source as enum ('booking_request','manual','import');

create table reservations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  source           reservation_source not null,
  booking_request_id uuid,
  quote_id         uuid,
  event_id         uuid,
  status           reservation_status not null default 'held',
  hold_expires_at  timestamptz,
  created_by       uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (status <> 'held' or hold_expires_at is not null)
);

create table reservation_allocations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  reservation_id     uuid not null,
  variant_id         uuid not null,
  inventory_unit_id  uuid,                 -- set for serialized, null for pooled
  quantity           integer not null default 1 check (quantity > 0),
  rental_period      tstzrange not null,   -- what the customer booked
  occupied_period    tstzrange not null,   -- rental_period expanded by setup/teardown buffers
  status             reservation_status not null,          -- denormalized from header for the constraint
  hold_expires_at    timestamptz,
  foreign key (organization_id, reservation_id)    references reservations(organization_id, id) on delete cascade,
  foreign key (organization_id, variant_id)        references product_variants(organization_id, id),
  foreign key (organization_id, inventory_unit_id) references inventory_units(organization_id, id),
  check (inventory_unit_id is null or quantity = 1),
  check (occupied_period @> rental_period),

  -- THE double-booking guarantee for serialized units:
  constraint no_unit_double_booking exclude using gist (
    inventory_unit_id with =,
    occupied_period   with &&
  ) where (inventory_unit_id is not null and status in ('held','confirmed'))
);
create index on reservation_allocations using gist (variant_id, occupied_period)
  where status in ('held','confirmed');
```

```sql
create type booking_request_status as enum ('pending','confirmed','expired','cancelled');

create table booking_requests (                  -- ADR 0002: "checkout started"
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  quote_id         uuid not null,
  status           booking_request_status not null default 'pending',
  hold_expires_at  timestamptz not null,       -- now() + organization_settings.booking_hold_minutes (default 15)
  customer_message text,
  confirmed_by     uuid references auth.users(id),
  confirmed_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, quote_id) references quotes(organization_id, id)
);
```

Flow: draft quote (no inventory) → `request_booking(quote)` creates `booking_requests` + `reservations(status='held', hold_expires_at)` via `reserve_inventory` → staff `confirm_booking` flips reservation to `confirmed` (re-checking the hold is still live) → or the hold expires and inventory is released automatically.

### 6.1 Why this design

- **Exclusion constraint** gives a database-level guarantee for the common case (each bounce house is one physical unit). Two concurrent transactions trying to allocate the same unit for overlapping periods cannot both commit — the second fails with `23P01`, which the function maps to `INSUFFICIENT_AVAILABILITY`.
- **Expired holds and the constraint:** because `now()` cannot appear in a constraint predicate, an expired-but-not-yet-swept hold would still block the unit at the constraint level. `reserve_inventory` therefore first releases expired holds on the candidate variant (`update … set status='released' where status='held' and hold_expires_at <= now()`) inside the same transaction, and the read path ignores them by predicate. The sweeper job is then only housekeeping.
- **Pooled stock** (chairs) cannot use an exclusion constraint (it is a sum, not a pairwise conflict). `reserve_inventory` takes `pg_advisory_xact_lock(hashtextextended(variant_id::text, 0))`, computes peak concurrent usage over the requested window, and inserts only if `peak + requested ≤ pooled_quantity − blocked_quantity`. All writers to a pooled variant go through this function, so the lock serializes them.
- **Peak usage, not sum:** for pooled items, three reservations that each overlap the request but not each other only consume the max concurrent amount. The function computes the maximum over the boundary points of overlapping allocations (a small sweep-line in SQL), mirrored by `domain/availability/capacity.ts` in TypeScript for unit tests.
- **Denormalized status:** `reservation_allocations.status`/`hold_expires_at` are copied from the header by trigger on every header status change (in the same transaction), because an exclusion constraint's `WHERE` can only see the row's own columns.
- **Buffers** are applied once at write time into `occupied_period`; the org/variant buffer at booking time is preserved even if defaults later change.
- **Product-level blocks** apply to all units of all variants; **unit-level** maintenance blocks remove only that unit from the candidate set.

### 6.2 Functions (implemented: `supabase/migrations/20260928000800_availability.sql`)

| Function | Who | Purpose |
|---|---|---|
| `check_availability(org, variant, start, end, qty, override_lead_time)` | staff (org.read), system | Exact counts, reasons, occupied window |
| `check_public_availability(org, variant, start, end, qty)` | anon, staff, system | `available` + `limited` only (D14); published products of active orgs; lead time always enforced |
| `reserve_inventory(org, items jsonb, status, source, replaces, override_lead_time, notes)` | staff (availability.write), system (holds only) | The only way to consume inventory; multi-item, atomic; optional atomic hold replacement |
| `confirm_reservation(id, ignore_weather)` | staff, system | Live hold → confirmed. Expired → `RA004`. Confirmed weather block → `RA002` unless staff override |
| `renew_hold(id)` | staff, system | Extends a live hold by `booking_hold_minutes`, at most `max_hold_renewals` times |
| `release_reservation(id)` | staff, system (holds only) | Hold → released; confirmed → cancelled (staff only) |
| `sweep_expired_holds()` | system | Housekeeping only |
| `confirm_weather_block(id)` / `lift_weather_block(id)` | staff only | Confirming flags overlapping bookings; never cancels |

Errors use SQLSTATE class `RA`: RA001 insufficient availability, RA002 blocked, RA003 outside lead time, RA004 hold expired, RA005 not found (including other tenants' data), RA006 invalid request/state, RA007 renewal limit.

Concurrency: per-variant `pg_advisory_xact_lock` (taken in sorted order: no deadlocks) + the unit exclusion constraint. A mutation test that removed both guards (with a widened race window) double-booked the last unit; with them, exactly one of ten concurrent requests wins.

### 6.3 Required test scenarios (implemented in `tests/integration/availability.test.ts` and `weather-blocks.test.ts`)

1. Qty 1, A = Sat 12:00–18:00 confirmed, B = Sat 15:00–20:00 → B rejected.
2. Qty 1, A = 12:00–18:00, B = 18:00–22:00, zero buffers → allowed (half-open). With 60-min buffers → rejected.
3. Qty 3, three overlapping confirmed → fourth rejected; a non-overlapping fourth → allowed.
4. Pooled 100 chairs: 60 at 10–14, 60 at 15–19 → both OK (peak 60); 50 more at 13–16 → rejected (peak 110).
5. Expired hold does not block; active hold does.
6. Cancelled/released allocations do not block.
7. Unit in maintenance excluded; other units still available.
8. Org blackout date blocks everything.
9. Multi-day (Fri 17:00 → Sun 12:00) conflicts with a Saturday booking.
10. Overnight across DST change computes correct occupied period.
11. **Race:** 10 concurrent `reserve_inventory` for the last unit → exactly 1 success, 9 × `INSUFFICIENT_AVAILABILITY`; same for pooled last-N.
12. Cross-tenant: reserve org B's variant with org A context → rejected.

## 7. Delivery / service areas

As implemented in migration `20260929000900_pricing_delivery_tax.sql`. Organization mileage settings (`primary_depot_*`, `free_delivery_miles`, `per_mile_rate_cents`, `maximum_delivery_miles`, `delivery_mileage_rounding`, `delivery_distance_basis`) live on `organization_settings` (migration 0004).

```sql
create type service_area_pricing as enum ('flat', 'mileage', 'manual_review');

create table service_areas (
  id, organization_id, name,
  pricing          service_area_pricing not null default 'mileage',
  flat_fee_cents   bigint check (>= 0),              -- required when pricing = 'flat'
  priority         integer not null default 0,
  is_active        boolean not null default true,
  revision         integer not null default 1,       -- bumped by app.bump_revision()
  created_at, updated_at, unique (organization_id, id)
);

create table service_area_rules (
  id, organization_id, service_area_id,               -- composite FK to service_areas
  rule_type   text check (rule_type in ('postal_code', 'city')),
  postal_code text check (postal_code ~ '^\d{5}$'),
  city citext, state text check (state ~ '^[A-Z]{2}$')
);

create table delivery_distance_cache (
  organization_id, provider, provider_version,
  route_key   text check (route_key ~ '^[0-9a-f]{64}$'),  -- sha256(normalized origin | destination)
  meters      integer check (meters >= 0),
  fetched_at, expires_at,                                 -- TTL 1–30 days (put_cached_distance)
  primary key (organization_id, provider, provider_version, route_key)
);
```

Functions (`put_cached_distance` is service-role only, ADR 0014):
- `delivery_area_context(org, city, state, postal)` returns `{areasConfigured, match}`, where a postal-code match beats a city match, and higher priority wins.
- `get_cached_distance(...)` and `put_cached_distance(...)`.

Cache rows can only be written through these functions, never directly (RLS). The resolution order and failure handling are described in ARCHITECTURE §7.4. Straight-line distance is never billed.

## 8. Pricing and tax

```sql
create type pricing_rule_type as enum ('extra_hour', 'overnight', 'additional_day', 'attendant_fee',
                                       'fee', 'discount_percent', 'discount_fixed', 'minimum_charge');

create table pricing_rules (
  id, organization_id, name (unique per org),
  rule_type     pricing_rule_type not null,
  scope         text check (scope in ('organization','category','product','variant')),
  category_id, product_id, variant_id,                -- composite FKs; exactly the one matching scope
  params        jsonb not null,                       -- per-type CHECK + Zod (RULE_PARAM_SCHEMAS)
  priority      integer not null default 0,
  discount_code citext,                               -- null = automatic
  valid_from date, valid_to date, is_active boolean,
  revision      integer not null default 1,           -- trigger-bumped on real changes only
  created_at, updated_at
);

create type tax_component as enum ('rental','add_on','delivery','labor','fee','discount','adjustment');
create type tax_jurisdiction_status as enum ('test', 'active');

create table tax_jurisdictions (
  id, organization_id, name, state,
  postal_codes                 text[],   -- empty = statewide; ZIP-specific beats statewide
  requires_review_postal_codes text[],   -- boundary ZIPs, which always require review
  status tax_jurisdiction_status default 'test',      -- test always requires review
  priority, is_active, revision, created_at, updated_at
);
create table tax_rates (id, organization_id, jurisdiction_id, name, rate_bps 0..5000, valid_from, valid_to);
create table tax_component_rules (organization_id, jurisdiction_id, component, taxable,
                                  primary key (jurisdiction_id, component));

create table pricing_calculations (      -- immutable (trigger); deleted only with the organization
  id, organization_id, engine_version,
  input jsonb, output jsonb,
  input_hash text,                       -- sha256(canonicalJson(input))
  currency, total_cents, manual_review_required,
  created_by_type, created_by, created_at
);
```

- **RLS:** select needs `org.read`. Rule, area and tax writes need `pricing.write`.
- **Server-only writes (ADR 0014):** `pricing_calculations` rows and `delivery_distance_cache` entries can only be written by `record_pricing_calculation` / `put_cached_distance`, which are executable by `service_role` only. The calculation writer also rejects inconsistent snapshots and non-member actors.
- **Context functions:** `pricing_context(org, variant_ids[])` and `tax_context(org, state, postal, date)`. Both are tenant-checked with `app.assert_can_act`, which raises `RA005` for other tenants.
- **No tax values are seeded by the platform.** A missing `tax_component_rules` row for a component is **unresolved** (review), never a silent default.

## 9. Customers, events, quotes

As implemented in `20260930001000_customers_events_quotes.sql` (ADR 0015). Differences from the
original design:

- there is no `quote_charges` table: the itemized lines are the immutable engine snapshot in
  `pricing_calculations.output`;
- totals and items are derived by triggers.

```sql
customers (id, organization_id, first_name, last_name, company_name, email citext, phone_e164,
           sms_opt_in, email_opt_in, source web|assistant|admin|import, notes, archived_at, …)
  -- unique (org, email), unique (org, phone); email or phone required

events (id, organization_id, customer_id, event_type, title,
        event_date, end_date, start_time, end_time, time_fold earlier|later,   -- as stated, local
        starts_at, ends_at,                                   -- derived: app.local_to_instant (DST-safe)
        address_line1..postal_code, guest_count, children_count, ages, budget, indoor_outdoor,
        water/power_available, surface_type, notes)

quote_counters (organization_id pk, next_value)             -- numbering; prefix in organization_settings

quotes (id, organization_id, quote_number (org-unique), customer_id, event_id,
        status draft|sent|viewed|accepted|declined|expired|cancelled,
        source admin|web|assistant, price_request jsonb, pricing_calculation_id → pricing_calculations,
        -- derived from the calculation by app.quotes_guard (never written by callers):
        currency, subtotal_cents, delivery_cents, discount_cents, tax_cents, total_cents,
        manual_review_required, review_reasons,
        review_approved_by/at, review_note,                   -- staff sign-off; reset on re-price
        token_hash (sha256 of the customer link token), expires_at, sent/viewed/accepted/declined/cancelled_at,
        customer_notes, internal_notes, created_by_type, created_by)
  -- check total = subtotal + tax; non-draft ⇒ priced

quote_items (quote_id, line_id, variant_id, product_id, kind, quantity, rental_period,
             product_name, unit_price_cents, line_total_cents, sort_order)
  -- rebuilt from the calculation input by app.quotes_sync_items; no write grants

booking_requests (id, organization_id, quote_id, customer_id, event_id,
                  status pending|confirmed|declined|cancelled, source web|assistant|admin,
                  reservation_id → reservations, customer_message, decided_by/at, decision_note, …)
  -- one pending request per quote; reservations.quote_id/event_id/booking_request_id FKs added
```

**Functions:**

| Function | Who may call it |
|---|---|
| `match_or_create_customer`, `create_event`, `create_quote` | staff, or the server's system context |
| `request_booking`, `renew_booking_hold`, `close_booking_request` | staff, or the system context |
| `confirm_booking_request` | staff only |
| `expire_quotes` | service role only |
| `public_quote_view`, `request_booking_by_token`, `renew_booking_hold_by_token`, `cancel_booking_by_token` | service role only, always keyed by tenant + token hash |

**Views:** `public_catalog_variants` (anon-safe; bookable variant ids and names only).

**Workflow boundaries** (`20260930001100`, ADR 0015 §10):

- `quotes.revision` is trigger-maintained and cannot be written directly.
- `quotes.submitted_contact` holds what a visitor typed; it is immutable.
- `booking_requests` records `quote_revision`, `pricing_calculation_id`, `items_signature` and
  `event_signature`.
- `quote_hold_budgets (quote_id, revision, used)` limits public holds and extensions to
  `1 + max_hold_renewals` per revision.
- The generic reservation functions refuse quote-managed reservations. A quote revision,
  cancellation, decline or expiry releases the quote's hold.

**Round 2** (`20260930001200`, ADR 0015 §11):

- A quote whose event changed after pricing is stale until it is re-priced
  (`app.quote_event_mismatch`). Editing an event releases the pending holds of its open quotes.
- `quotes.status = 'accepted'` requires a confirmed booking request of the same revision
  (trigger `quotes_require_booking`).
- Renewal and confirmation share `app.assert_booking_current`.

**Round 3** (`20260930001300`, ADR 0015 §12):

- An accepted quote's links and snapshot, its event's date, times and address, and its confirmed
  reservation are frozen (`RA010`).
- `pricing_calculations.input.destination` records the priced address. Event validity is
  checked against the snapshot, never against `price_request`.
- Holds are capped at the quote's expiry. Expiry decisions use `clock_timestamp()` after locking.
- Variant advisory locks are taken in ascending order per transaction (`RA014` otherwise).
  Catalog and block edits lock the organization exclusively.

**MEDIUM findings** (`20260930001400`, ADR 0015 §13):

- Every managed-hold operation verifies the reservation's reciprocal links
  (`app.assert_reservation_linked`, `RA013`). The automatic close and cap paths act only on holds
  linked back to the request.
- `quote_hold_budgets` is scoped to a quote revision, not to a visitor or customer.

**Per-visitor public hold cap** (`20260930001500`, ADR 0015 §14):

- `reservations.public_visitor_hash` holds the SHA-256 of the server-issued anonymous visitor
  token. It is set on public holds only and immutable once the hold belongs to a request.
- `organization_settings.max_public_holds_per_visitor` defaults to 2 live public holds per
  visitor per organization. It is enforced atomically in `request_booking` (`RA015`
  `PUBLIC_HOLD_LIMIT`). Staff holds are exempt.

**RLS:**

- `customers`: `customers.read` / `customers.write`.
- `events`, `quotes`, `quote_items`, `booking_requests`: select with `org.read`.
- `events` writes need `events.write`; `quotes` writes need `quotes.write`.
- There are no deletes on customers or quotes (archive or cancel instead).

## 10. Conversations & AI actions

```sql
create type conversation_status as enum ('active','awaiting_customer','needs_human','converted','closed');
create type message_role as enum ('user','assistant','tool','system_note');

create table conversations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  channel          text not null default 'web',     -- 'web' now; 'sms','admin' later
  visitor_id       text,                            -- opaque signed cookie id for anonymous visitors
  customer_id      uuid,
  event_id         uuid,
  status           conversation_status not null default 'active',
  event_draft      jsonb not null default '{}'::jsonb,  -- Zod-validated slot state; promoted to events row
  prompt_version   text,
  message_count    integer not null default 0,
  tool_call_count  integer not null default 0,
  token_usage      integer not null default 0,
  last_message_at  timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, customer_id) references customers(organization_id, id),
  foreign key (organization_id, event_id)    references events(organization_id, id)
);

create table conversation_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  conversation_id  uuid not null,
  role             message_role not null,
  content          text,
  structured       jsonb,                   -- recommendations/questions payload for assistant turns
  created_at       timestamptz not null default now(),
  foreign key (organization_id, conversation_id) references conversations(organization_id, id) on delete cascade
);

create table ai_actions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  conversation_id  uuid,
  message_id       uuid,
  tool_name        text not null,
  tool_call_id     text,                    -- provider id; idempotency key with conversation_id
  input            jsonb,
  output           jsonb,
  status           text not null check (status in ('ok','rejected_validation','rejected_policy','error','guardrail_violation')),
  error_code       text,
  duration_ms      integer,
  model            text,
  prompt_version   text,
  created_at       timestamptz not null default now(),
  unique (conversation_id, tool_call_id),
  foreign key (organization_id, conversation_id) references conversations(organization_id, id) on delete cascade
);
create index on ai_actions (organization_id, created_at desc);
```

`event_draft` is JSONB intentionally: it is transient, partially filled working state whose shape evolves with the assistant; it is promoted to a typed `events` row once `create_event` runs.

## 11. Audit log

```sql
create table audit_logs (
  id               bigint generated always as identity primary key,
  organization_id  uuid references organizations(id),
  actor_type       text not null check (actor_type in ('user','ai','system','public')),
  actor_user_id    uuid,
  ai_action_id     uuid,
  action           text not null,          -- 'product.updated','quote.sent','member.role_changed'
  entity_type      text not null,
  entity_id        uuid,
  changes          jsonb,                  -- {field: [old, new]} for trigger-written rows
  ip_address       inet,
  user_agent       text,
  request_id       text,
  created_at       timestamptz not null default now()
);
create index on audit_logs (organization_id, created_at desc);
create index on audit_logs (organization_id, entity_type, entity_id);
-- No UPDATE/DELETE privileges for any API role; inserts only via app.write_audit() or triggers.
```

## 12. RLS strategy

### 12.1 Helper functions (schema `app`, not exposed via PostgREST)

```sql
create function app.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active');
$$;

create function app.has_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    join public.role_permissions rp on rp.role = m.role
    where m.organization_id = p_org and m.user_id = auth.uid()
      and m.status = 'active' and rp.permission = p_permission);
$$;
```

`SECURITY DEFINER` avoids recursive RLS on `organization_members`. Policies wrap calls as `(select app.has_permission(...))` so Postgres evaluates them once per statement (initPlan) rather than per row.

### 12.2 Policy template (applied to every tenant table)

```sql
alter table products enable row level security;
alter table products force row level security;

create policy products_select on products for select to authenticated
  using ((select app.has_permission(organization_id, 'org.read')));

create policy products_insert on products for insert to authenticated
  with check ((select app.has_permission(organization_id, 'catalog.write')));

create policy products_update on products for update to authenticated
  using      ((select app.has_permission(organization_id, 'catalog.write')))
  with check ((select app.has_permission(organization_id, 'catalog.write')));

create policy products_delete on products for delete to authenticated
  using ((select app.has_permission(organization_id, 'catalog.write')));
```

Rules:

- **Default deny:** RLS enabled + forced on every table in `public`; a CI check fails if any table lacks RLS or policies (query `pg_class.relrowsecurity`).
- `organization_id` is **immutable** after insert (trigger), so an UPDATE cannot move a row to another tenant.
- No policies for `anon` on base tables. Public catalog access goes through **explicit-column views** (`public_catalog_products`, `public_catalog_categories`, `public_product_media`) owned by a restricted role, filtered to `is_published and archived_at is null and organization.status = 'active'`, excluding `internal_notes`, costs, unit labels. `anon` gets `select` on the views only. (Supabase's linter flags security-definer views; these are the deliberate exceptions, documented in an ADR.)
- `audit_logs`, `ai_actions`: select for `audit.read` / `conversations.read`; no insert/update/delete for API roles (writes via definer functions / system context).
- `role_permissions`: readable by `authenticated`, writable by nobody via API.
- `organizations`: members can select their orgs; update requires `settings.write`; insert only via `app.create_organization()` (makes caller owner) or system context.
- **Storage:** bucket `product-media`, object path prefix `{organization_id}/…`; `storage.objects` policies check `app.has_permission((storage.foldername(name))[1]::uuid, 'catalog.write')` for writes; public read for published media via signed or public URLs (Decision D6).

### 12.3 Isolation test matrix

Automated: for every table in `public`, generate cases {anon, user-A-owner, user-A-staff, user-B-owner} × {select, insert, update, delete} on a row belonging to org A, and assert the expected outcome. The test enumerates tables from `information_schema` so **a new table without a policy/test fails CI**.

## 13. Seed & import structure

- `supabase/seed.sql` — deterministic dev fixtures: three fictional orgs ("Acme Party Rentals", "FunTime Rentals", "Test Tenant B"), users for each role, a small catalog, service areas, pricing rules. No real customer data.
- `seeds/tenants/<slug>/tenant.json` — a **tenant configuration bundle** (data only, validated by `scripts/tenant/bundle-schema.ts`): organization identity, domains, settings (branding, contact, buffers, lead time, hold minutes, wind threshold, depot + mileage), categories with their rule overrides, policies, and an optional owner email (which produces a one-time owner invitation).
- `node scripts/import-tenant.ts <bundle-dir>` (with `DATABASE_URL`) applies it idempotently in one transaction. Tiky Jumps is onboarded with the same tool any future tenant uses.
- Products are **not** part of the bundle: they come through the CSV import (§13.1), and photos are uploaded per product with rights metadata.

### 13.1 CSV import staging (ADR 0006, ADR 0011)

Source formats are handled by adapters that map onto the canonical product model; no source column names appear in the schema.

```sql
create table import_batches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  kind             text not null check (kind in ('products','categories','customers')),
  source           text not null,             -- 'ers_csv','spreadsheet'
  original_filename text,
  storage_path     text,                      -- private bucket, org-prefixed
  adapter_id       text not null,             -- 'generic_csv','ers' (code-defined adapters)
  mapping          jsonb,                     -- canonical field → source column + transform
  status           text not null check (status in ('uploaded','parsed','mapped','validated','committed','failed','cancelled')),
  summary          jsonb,                     -- counts: create/update/skip/error
  created_by       uuid references auth.users(id),
  created_at timestamptz not null default now(), committed_at timestamptz,
  unique (organization_id, id)
);

create table import_rows (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  batch_id         uuid not null,
  row_number       integer not null,
  raw              jsonb not null,            -- original CSV cells
  mapped           jsonb,                     -- after mapping, before validation
  action           text check (action in ('create','update','skip')),
  errors           jsonb not null default '[]',
  warnings         jsonb not null default '[]',
  target_id        uuid,                      -- created/updated product id
  foreign key (organization_id, batch_id) references import_batches(organization_id, id) on delete cascade
);
```

## 14. Migration plan

| Migration | Milestone |
|---|---|
| `0001_extensions_and_helpers` (extensions, `app` schema, `updated_at` trigger, immutable-org trigger) | M1 |
| `0002_tenancy` (organizations, domains, settings, policies, profiles, members, invitations, role_permissions, RLS) | M1 |
| `0003_audit` | M1 |
| `0004_catalog` (categories, products, variants, units, media, relations, public views, storage policies) | M2 |
| `0005_availability` (blocks, rules, reservations, allocations, functions) | M3 |
| `0004b_imports` (import batches/rows, mapping presets) | M2 |
| `0004c_settings_delivery_wind` (rename depot/wind columns; mileage settings) | M2 |
| `0005b_weather_blocks` | M3 |
| `0006_service_areas_pricing` (service areas incl. mileage rules, pricing rules, tax jurisdictions/rates/component rules) | M4 |
| `0007_customers_events_quotes` (+ counters, status trigger, booking requests) | M5 |
| `0008_conversations_ai` | M7 |
