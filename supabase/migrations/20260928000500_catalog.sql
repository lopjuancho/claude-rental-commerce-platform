-- Milestone 2 · Catalog: categories, products, variants, inventory units, media, relations.
-- Design: DATABASE.md §4, ADR 0003 (override chain), ADR 0006 (media rights), ADR 0010 (wind).
-- Every child table carries organization_id and references parents by (organization_id, id).

create type public.pricing_type as enum ('per_event', 'hourly', 'daily', 'per_unit');
create type public.tracking_mode as enum ('serialized', 'pooled');
create type public.event_type as enum (
  'birthday', 'school', 'church', 'corporate', 'community', 'graduation',
  'festival', 'wedding', 'sports', 'holiday', 'other'
);
create type public.media_kind as enum ('image', 'video');
create type public.media_source as enum ('upload', 'import', 'supplier');
create type public.media_rights_status as enum ('owned', 'licensed', 'supplier_permitted', 'unverified');
create type public.product_relation_type as enum ('addon', 'recommended', 'requires');

-- Rejects malformed ids without raising (used where paths are parsed).
create function app.try_uuid(p_value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_value::uuid;
exception when others then
  return null;
end;
$$;
revoke execute on function app.try_uuid(text) from public;
grant execute on function app.try_uuid(text) to anon, authenticated, service_role;

-- ───────────────────────────── categories ─────────────────────────────
create table public.categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  parent_id       uuid,
  name            text not null check (length(btrim(name)) between 1 and 120),
  slug            text not null check (slug ~ '^[a-z0-9](-?[a-z0-9])*$' and length(slug) <= 120),
  description     text check (length(description) <= 5000),
  sort_order      integer not null default 0,
  is_published    boolean not null default true,
  -- "category" level of the override chain (ADR 0003); null = inherit
  setup_buffer_minutes      integer check (setup_buffer_minutes between 0 and 1440),
  teardown_buffer_minutes   integer check (teardown_buffer_minutes between 0 and 1440),
  included_duration_minutes integer check (included_duration_minutes > 0),
  overnight_allowed         boolean,
  wind_sensitive            boolean,
  wind_threshold_mph        smallint check (wind_threshold_mph > 0),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, slug),
  check (parent_id is distinct from id),
  foreign key (organization_id, parent_id) references public.categories (organization_id, id) on delete set null (parent_id)
);
create index categories_org_idx on public.categories (organization_id, sort_order);

-- Category trees must stay acyclic.
create function app.categories_no_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is not null and exists (
    with recursive ancestors as (
      select c.id, c.parent_id from public.categories c where c.id = new.parent_id
      union all
      select c.id, c.parent_id from public.categories c join ancestors a on c.id = a.parent_id
    )
    select 1 from ancestors where id = new.id
  ) then
    raise exception 'category hierarchy cannot contain cycles' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger categories_no_cycle before insert or update of parent_id on public.categories
  for each row execute function app.categories_no_cycle();

-- ───────────────────────────── products ─────────────────────────────
create table public.products (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  primary_category_id  uuid,
  name                 text not null check (length(btrim(name)) between 1 and 200),
  slug                 text not null check (slug ~ '^[a-z0-9](-?[a-z0-9])*$' and length(slug) <= 160),
  short_description    text check (length(short_description) <= 300),
  description          text check (length(description) <= 20000),
  -- merchandising
  is_published         boolean not null default false,
  is_featured          boolean not null default false,
  sort_order           integer not null default 0,
  -- pricing headline (rules arrive in M4)
  pricing_type              public.pricing_type not null default 'per_event',
  base_price_cents          bigint not null check (base_price_cents between 0 and 100000000),
  included_duration_minutes integer check (included_duration_minutes > 0),
  minimum_rental_minutes    integer check (minimum_rental_minutes > 0),
  -- "product" level of the override chain (ADR 0003); null = inherit
  setup_buffer_minutes          integer check (setup_buffer_minutes between 0 and 1440),
  teardown_buffer_minutes       integer check (teardown_buffer_minutes between 0 and 1440),
  min_booking_lead_time_minutes integer check (min_booking_lead_time_minutes >= 0),
  overnight_allowed             boolean,
  wind_sensitive                boolean,
  wind_threshold_mph            smallint check (wind_threshold_mph > 0),
  -- suitability: typed because the assistant filters and makes claims on these
  wet_allowed          boolean not null default false,
  dry_allowed          boolean not null default true,
  minimum_age          smallint check (minimum_age between 0 and 120),
  maximum_age          smallint check (maximum_age between 0 and 120),
  recommended_capacity smallint check (recommended_capacity > 0),
  max_rider_weight_lbs smallint check (max_rider_weight_lbs > 0),
  ideal_event_types    public.event_type[] not null default '{}',
  indoor_allowed       boolean not null default false,
  outdoor_allowed      boolean not null default true,
  allowed_surfaces     text[] not null default '{}'
                       check (allowed_surfaces <@ array['grass', 'turf', 'concrete', 'asphalt', 'dirt', 'gravel', 'indoor_floor']),
  -- physical requirements
  space_length_ft        numeric(5, 1) check (space_length_ft > 0),
  space_width_ft         numeric(5, 1) check (space_width_ft > 0),
  space_height_ft        numeric(5, 1) check (space_height_ft > 0),
  power_outlets_required smallint check (power_outlets_required >= 0),
  power_notes            text check (length(power_notes) <= 500),
  water_required         boolean not null default false,
  operator_required      boolean not null default false,
  attendants_required    smallint not null default 0 check (attendants_required between 0 and 20),
  setup_minutes          integer check (setup_minutes between 0 and 1440),
  teardown_minutes       integer check (teardown_minutes between 0 and 1440),
  setup_requirements     text check (length(setup_requirements) <= 2000),
  anchoring_methods      text[] not null default '{}'
                         check (anchoring_methods <@ array['stakes', 'sandbags', 'water_barrels']),
  -- discovery
  tags        text[] not null default '{}' check (cardinality(tags) <= 30),
  extra_specs jsonb not null default '{}'::jsonb
              check (jsonb_typeof(extra_specs) = 'object' and pg_column_size(extra_specs) <= 8192),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(short_description, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'C')
  ) stored,
  -- internal: never exposed publicly or to the assistant
  internal_notes  text check (length(internal_notes) <= 5000),
  external_source text check (external_source ~ '^[a-z0-9_]{1,40}$'),
  external_ref    text check (length(external_ref) between 1 and 200),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, slug),
  unique (organization_id, external_source, external_ref),
  check (wet_allowed or dry_allowed),
  check (indoor_allowed or outdoor_allowed),
  check (maximum_age is null or minimum_age is null or maximum_age >= minimum_age),
  check ((external_source is null) = (external_ref is null)),
  foreign key (organization_id, primary_category_id)
    references public.categories (organization_id, id) on delete set null (primary_category_id)
);
create index products_org_idx on public.products (organization_id, sort_order);
create index products_tags_idx on public.products using gin (tags);
create index products_search_idx on public.products using gin (search_vector);
create index products_name_trgm_idx on public.products using gin (name extensions.gin_trgm_ops);

create table public.product_categories (
  organization_id uuid not null,
  product_id      uuid not null,
  category_id     uuid not null,
  primary key (product_id, category_id),
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade,
  foreign key (organization_id, category_id) references public.categories (organization_id, id) on delete cascade
);
create index product_categories_category_idx on public.product_categories (organization_id, category_id);

-- ───────────────────────────── variants & inventory ─────────────────────────────
-- A variant is the rentable SKU. Every product has exactly one default variant (created by trigger).
create table public.product_variants (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null,
  product_id              uuid not null,
  name                    text not null default 'Default' check (length(btrim(name)) between 1 and 120),
  sku                     text check (length(sku) between 1 and 80),
  is_default              boolean not null default false,
  price_override_cents    bigint check (price_override_cents between 0 and 100000000),
  tracking_mode           public.tracking_mode not null default 'serialized',
  pooled_quantity         integer check (pooled_quantity between 0 and 1000000),
  setup_buffer_minutes    integer check (setup_buffer_minutes between 0 and 1440),
  teardown_buffer_minutes integer check (teardown_buffer_minutes between 0 and 1440),
  is_active               boolean not null default true,
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, sku),
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade,
  check ((tracking_mode = 'pooled') = (pooled_quantity is not null))
);
create unique index product_variants_one_default on public.product_variants (product_id) where is_default;
create index product_variants_product_idx on public.product_variants (organization_id, product_id);

create table public.inventory_units (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  variant_id      uuid not null,
  label           text not null check (length(btrim(label)) between 1 and 120),
  serial_number   text check (length(serial_number) <= 120),
  status          text not null default 'active' check (status in ('active', 'retired')),
  condition_notes text check (length(condition_notes) <= 2000),
  acquired_on     date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (variant_id, label),
  foreign key (organization_id, variant_id) references public.product_variants (organization_id, id) on delete cascade
);
create index inventory_units_variant_idx on public.inventory_units (organization_id, variant_id);

-- Units only make sense for serialized variants.
create function app.inventory_units_require_serialized()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select v.tracking_mode from public.product_variants v where v.id = new.variant_id) <> 'serialized' then
    raise exception 'inventory units can only belong to serialized variants' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger inventory_units_serialized before insert or update of variant_id on public.inventory_units
  for each row execute function app.inventory_units_require_serialized();

create function app.create_default_variant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.product_variants (organization_id, product_id, name, is_default)
  values (new.organization_id, new.id, 'Default', true);
  return new;
end;
$$;
create trigger products_default_variant after insert on public.products
  for each row execute function app.create_default_variant();

-- ───────────────────────────── media ─────────────────────────────
create table public.product_media (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  product_id        uuid not null,
  kind              public.media_kind not null default 'image',
  storage_provider  text not null default 'supabase' check (storage_provider in ('supabase')),
  storage_path      text not null check (length(storage_path) <= 500 and storage_path !~ '\.\.'),
  alt_text          text check (length(alt_text) <= 300),
  width             integer check (width > 0),
  height            integer check (height > 0),
  sort_order        integer not null default 0,
  is_primary        boolean not null default false,
  -- ownership & rights (ADR 0006)
  uploaded_by       uuid references auth.users (id) on delete set null,
  source            public.media_source not null,
  original_filename text check (length(original_filename) <= 255),
  rights_status     public.media_rights_status not null default 'unverified',
  rights_notes      text check (length(rights_notes) <= 1000),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  -- Objects live under the owning organization's prefix: never another tenant's files.
  check (storage_path like organization_id::text || '/%'),
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade
);
create unique index product_media_one_primary on public.product_media (product_id) where is_primary;
create index product_media_product_idx on public.product_media (organization_id, product_id, sort_order);

-- ───────────────────────────── relations ─────────────────────────────
create table public.product_relations (
  organization_id    uuid not null,
  product_id         uuid not null,
  related_product_id uuid not null,
  relation_type      public.product_relation_type not null,
  sort_order         integer not null default 0,
  primary key (product_id, related_product_id, relation_type),
  check (product_id <> related_product_id),
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade,
  foreign key (organization_id, related_product_id) references public.products (organization_id, id) on delete cascade
);

-- ───────────────────────────── triggers ─────────────────────────────
create trigger categories_updated_at before update on public.categories
  for each row execute function app.set_updated_at();
create trigger products_updated_at before update on public.products
  for each row execute function app.set_updated_at();
create trigger product_variants_updated_at before update on public.product_variants
  for each row execute function app.set_updated_at();
create trigger inventory_units_updated_at before update on public.inventory_units
  for each row execute function app.set_updated_at();
create trigger product_media_updated_at before update on public.product_media
  for each row execute function app.set_updated_at();

create trigger categories_org_immutable before update on public.categories
  for each row execute function app.prevent_organization_change();
create trigger products_org_immutable before update on public.products
  for each row execute function app.prevent_organization_change();
create trigger product_categories_org_immutable before update on public.product_categories
  for each row execute function app.prevent_organization_change();
create trigger product_variants_org_immutable before update on public.product_variants
  for each row execute function app.prevent_organization_change();
create trigger inventory_units_org_immutable before update on public.inventory_units
  for each row execute function app.prevent_organization_change();
create trigger product_media_org_immutable before update on public.product_media
  for each row execute function app.prevent_organization_change();
create trigger product_relations_org_immutable before update on public.product_relations
  for each row execute function app.prevent_organization_change();

create trigger audit_categories after insert or update or delete on public.categories
  for each row execute function app.audit_row_change('category');
create trigger audit_products after insert or update or delete on public.products
  for each row execute function app.audit_row_change('product');
create trigger audit_product_variants after insert or update or delete on public.product_variants
  for each row execute function app.audit_row_change('variant');
create trigger audit_inventory_units after insert or update or delete on public.inventory_units
  for each row execute function app.audit_row_change('inventory_unit');
create trigger audit_product_media after insert or update or delete on public.product_media
  for each row execute function app.audit_row_change('media');

revoke execute on function app.categories_no_cycle(), app.inventory_units_require_serialized(),
  app.create_default_variant() from public;

-- ───────────────────────────── RLS ─────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['categories', 'products', 'product_categories', 'product_variants',
                           'inventory_units', 'product_media', 'product_relations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format($p$create policy %I on public.%I for select to authenticated
                     using ((select app.has_permission(organization_id, 'org.read')))$p$, t || '_select', t);
    execute format($p$create policy %I on public.%I for insert to authenticated
                     with check ((select app.has_permission(organization_id, 'catalog.write')))$p$, t || '_insert', t);
    execute format($p$create policy %I on public.%I for update to authenticated
                     using ((select app.has_permission(organization_id, 'catalog.write')))
                     with check ((select app.has_permission(organization_id, 'catalog.write')))$p$, t || '_update', t);
    execute format($p$create policy %I on public.%I for delete to authenticated
                     using ((select app.has_permission(organization_id, 'catalog.write')))$p$, t || '_delete', t);
  end loop;
end $$;

-- The generated search vector is never written directly.
revoke update (search_vector) on public.products from authenticated;
-- Media uploader is always the caller.
create function app.stamp_media_uploader()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.uploaded_by := (select auth.uid());
  end if;
  return new;
end;
$$;
revoke execute on function app.stamp_media_uploader() from public;
create trigger product_media_stamp_uploader before insert on public.product_media
  for each row execute function app.stamp_media_uploader();

-- ───────────────────────────── public catalog views ─────────────────────────────
-- Explicit-column views for anonymous storefront reads (ADR 0001, DATABASE.md §12.2).
-- They run with the owner's rights (security_invoker = false) and therefore filter explicitly:
-- active organization, published, not archived. Internal fields are never selected.
create view public.public_catalog_categories
with (security_barrier = true) as
select c.id, c.organization_id, c.parent_id, c.name, c.slug, c.description, c.sort_order
from public.categories c
join public.organizations o on o.id = c.organization_id
where o.status = 'active' and c.is_published and c.archived_at is null;

create view public.public_catalog_products
with (security_barrier = true) as
select
  p.id, p.organization_id, p.primary_category_id, p.name, p.slug, p.short_description, p.description,
  p.is_featured, p.sort_order, p.pricing_type, p.base_price_cents, p.included_duration_minutes,
  p.minimum_rental_minutes, p.wet_allowed, p.dry_allowed, p.minimum_age, p.maximum_age,
  p.recommended_capacity, p.max_rider_weight_lbs, p.ideal_event_types, p.indoor_allowed, p.outdoor_allowed,
  p.allowed_surfaces, p.space_length_ft, p.space_width_ft, p.space_height_ft, p.power_outlets_required,
  p.power_notes, p.water_required, p.operator_required, p.attendants_required, p.setup_requirements,
  p.anchoring_methods, p.tags, p.extra_specs,
  coalesce(p.wind_sensitive, pc.wind_sensitive, false) as wind_sensitive,
  coalesce(p.wind_threshold_mph, pc.wind_threshold_mph, s.wind_threshold_mph) as wind_threshold_mph,
  array(
    select pcat.category_id from public.product_categories pcat
    join public.categories cat on cat.id = pcat.category_id
    where pcat.product_id = p.id and cat.is_published and cat.archived_at is null
  ) as category_ids
from public.products p
join public.organizations o on o.id = p.organization_id
join public.organization_settings s on s.organization_id = p.organization_id
left join public.categories pc on pc.id = p.primary_category_id
where o.status = 'active' and p.is_published and p.archived_at is null;

create view public.public_catalog_product_media
with (security_barrier = true) as
select m.id, m.organization_id, m.product_id, m.kind, m.storage_path, m.alt_text, m.width, m.height,
       m.sort_order, m.is_primary
from public.product_media m
join public.products p on p.id = m.product_id
join public.organizations o on o.id = m.organization_id
where o.status = 'active' and p.is_published and p.archived_at is null
  and m.rights_status <> 'unverified';

revoke all on public.public_catalog_categories, public.public_catalog_products,
  public.public_catalog_product_media from anon, authenticated;
grant select on public.public_catalog_categories, public.public_catalog_products,
  public.public_catalog_product_media to anon, authenticated, service_role;

-- ───────────────────────────── storage ─────────────────────────────
-- Private bucket; the storefront receives short-lived signed URLs for published media only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-media', 'product-media', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4'])
on conflict (id) do nothing;

create policy product_media_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'product-media'
         and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'org.read')));
create policy product_media_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-media'
              and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'catalog.write')));
create policy product_media_objects_update on storage.objects for update to authenticated
  using (bucket_id = 'product-media'
         and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'catalog.write')))
  with check (bucket_id = 'product-media'
              and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'catalog.write')));
create policy product_media_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-media'
         and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'catalog.write')));
