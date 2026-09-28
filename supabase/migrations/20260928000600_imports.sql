-- Milestone 2 · Staged product import (ADR 0006, ADR 0011).
-- Source formats are handled by code-defined adapters that map onto the canonical product model;
-- nothing here knows about any particular source system's column names.

create type public.import_status as enum ('parsed', 'validated', 'committed', 'failed', 'cancelled');
create type public.import_row_action as enum ('create', 'update', 'skip');

create table public.import_mapping_presets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  adapter_id      text not null check (adapter_id ~ '^[a-z0-9_]{1,40}$'),
  name            text not null check (length(btrim(name)) between 1 and 120),
  mapping         jsonb not null check (jsonb_typeof(mapping) = 'object' and pg_column_size(mapping) <= 32768),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.import_batches (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  kind              text not null default 'products' check (kind in ('products')),
  adapter_id        text not null check (adapter_id ~ '^[a-z0-9_]{1,40}$'),
  -- Written to products.external_source so re-imports from the same source update, not duplicate.
  external_source   text not null check (external_source ~ '^[a-z0-9_]{1,40}$'),
  original_filename text check (length(original_filename) <= 255),
  headers           text[] not null check (cardinality(headers) between 1 and 200),
  row_count         integer not null check (row_count between 0 and 5000),
  mapping           jsonb check (mapping is null or (jsonb_typeof(mapping) = 'object' and pg_column_size(mapping) <= 32768)),
  status            public.import_status not null default 'parsed',
  summary           jsonb,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  committed_at      timestamptz,
  unique (organization_id, id)
);
create index import_batches_org_idx on public.import_batches (organization_id, created_at desc);

create table public.import_rows (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  batch_id        uuid not null,
  row_number      integer not null check (row_number > 0),
  raw             jsonb not null check (jsonb_typeof(raw) = 'object' and pg_column_size(raw) <= 65536),
  mapped          jsonb check (mapped is null or jsonb_typeof(mapped) = 'object'),
  action          public.import_row_action,
  errors          jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  warnings        jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  target_id       uuid,
  unique (batch_id, row_number),
  -- A row with validation errors can never be written.
  check (action is distinct from 'create' or errors = '[]'::jsonb),
  check (action is distinct from 'update' or errors = '[]'::jsonb),
  foreign key (organization_id, batch_id) references public.import_batches (organization_id, id) on delete cascade
);

create trigger import_mapping_presets_updated_at before update on public.import_mapping_presets
  for each row execute function app.set_updated_at();
create trigger import_batches_updated_at before update on public.import_batches
  for each row execute function app.set_updated_at();
create trigger import_mapping_presets_org_immutable before update on public.import_mapping_presets
  for each row execute function app.prevent_organization_change();
create trigger import_batches_org_immutable before update on public.import_batches
  for each row execute function app.prevent_organization_change();
create trigger import_rows_org_immutable before update on public.import_rows
  for each row execute function app.prevent_organization_change();

-- Import data can contain internal notes and costs: catalog.write for every operation.
do $$
declare
  t text;
begin
  foreach t in array array['import_mapping_presets', 'import_batches', 'import_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format($p$create policy %I on public.%I for all to authenticated
                     using ((select app.has_permission(organization_id, 'catalog.write')))
                     with check ((select app.has_permission(organization_id, 'catalog.write')))$p$, t || '_all', t);
  end loop;
end $$;

-- Committed batches are immutable history.
create function app.import_batches_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'committed' then
    raise exception 'committed imports cannot be changed' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke execute on function app.import_batches_guard() from public;
create trigger import_batches_guard before update on public.import_batches
  for each row execute function app.import_batches_guard();

-- ───────────────────────────── commit ─────────────────────────────
-- Writes a validated batch into the catalog in ONE transaction. SECURITY INVOKER: every insert and
-- update is checked by the caller's RLS policies (catalog.write), so a batch can only ever write
-- into its own organization. Imports never clear existing values: absent/null fields are ignored.
create function public.commit_product_import(p_batch_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  b public.import_batches;
  r public.import_rows;
  j jsonb;
  v public.products;
  pid uuid;
  vid uuid;
  cid uuid;
  cat jsonb;
  existed boolean;
  qty integer;
  have integer;
  mode public.tracking_mode;
  n_created integer := 0;
  n_updated integer := 0;
  n_skipped integer := 0;
  v_summary jsonb;
  total integer;
begin
  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'import batch not found' using errcode = 'no_data_found';
  end if;
  if b.status <> 'validated' then
    raise exception 'import batch must be validated before commit (status: %)', b.status
      using errcode = 'check_violation';
  end if;

  for r in
    select * from public.import_rows where batch_id = b.id order by row_number
  loop
    if r.action is null or r.action = 'skip' then
      n_skipped := n_skipped + 1;
      continue;
    end if;

    j := r.mapped;
    v := jsonb_populate_record(null::public.products, j);

    select p.id into pid
    from public.products p
    where p.organization_id = b.organization_id
      and ((v.external_ref is not null and p.external_source = b.external_source and p.external_ref = v.external_ref)
           or (v.external_ref is null and p.slug = v.slug))
    limit 1;
    existed := pid is not null;

    if existed then
      update public.products p set
        name = coalesce(v.name, p.name),
        short_description = coalesce(v.short_description, p.short_description),
        description = coalesce(v.description, p.description),
        is_published = coalesce(v.is_published, p.is_published),
        pricing_type = coalesce(v.pricing_type, p.pricing_type),
        base_price_cents = coalesce(v.base_price_cents, p.base_price_cents),
        included_duration_minutes = coalesce(v.included_duration_minutes, p.included_duration_minutes),
        minimum_rental_minutes = coalesce(v.minimum_rental_minutes, p.minimum_rental_minutes),
        setup_buffer_minutes = coalesce(v.setup_buffer_minutes, p.setup_buffer_minutes),
        teardown_buffer_minutes = coalesce(v.teardown_buffer_minutes, p.teardown_buffer_minutes),
        overnight_allowed = coalesce(v.overnight_allowed, p.overnight_allowed),
        wind_sensitive = coalesce(v.wind_sensitive, p.wind_sensitive),
        wind_threshold_mph = coalesce(v.wind_threshold_mph, p.wind_threshold_mph),
        wet_allowed = coalesce(v.wet_allowed, p.wet_allowed),
        dry_allowed = coalesce(v.dry_allowed, p.dry_allowed),
        minimum_age = coalesce(v.minimum_age, p.minimum_age),
        maximum_age = coalesce(v.maximum_age, p.maximum_age),
        recommended_capacity = coalesce(v.recommended_capacity, p.recommended_capacity),
        max_rider_weight_lbs = coalesce(v.max_rider_weight_lbs, p.max_rider_weight_lbs),
        ideal_event_types = case when j ? 'ideal_event_types' then v.ideal_event_types else p.ideal_event_types end,
        indoor_allowed = coalesce(v.indoor_allowed, p.indoor_allowed),
        outdoor_allowed = coalesce(v.outdoor_allowed, p.outdoor_allowed),
        allowed_surfaces = case when j ? 'allowed_surfaces' then v.allowed_surfaces else p.allowed_surfaces end,
        space_length_ft = coalesce(v.space_length_ft, p.space_length_ft),
        space_width_ft = coalesce(v.space_width_ft, p.space_width_ft),
        space_height_ft = coalesce(v.space_height_ft, p.space_height_ft),
        power_outlets_required = coalesce(v.power_outlets_required, p.power_outlets_required),
        power_notes = coalesce(v.power_notes, p.power_notes),
        water_required = coalesce(v.water_required, p.water_required),
        operator_required = coalesce(v.operator_required, p.operator_required),
        attendants_required = coalesce(v.attendants_required, p.attendants_required),
        setup_minutes = coalesce(v.setup_minutes, p.setup_minutes),
        teardown_minutes = coalesce(v.teardown_minutes, p.teardown_minutes),
        setup_requirements = coalesce(v.setup_requirements, p.setup_requirements),
        tags = case when j ? 'tags' then v.tags else p.tags end,
        internal_notes = coalesce(v.internal_notes, p.internal_notes)
      where p.id = pid;
      n_updated := n_updated + 1;
    else
      insert into public.products (
        organization_id, name, slug, short_description, description, is_published, pricing_type,
        base_price_cents, included_duration_minutes, minimum_rental_minutes, setup_buffer_minutes,
        teardown_buffer_minutes, overnight_allowed, wind_sensitive, wind_threshold_mph, wet_allowed,
        dry_allowed, minimum_age, maximum_age, recommended_capacity, max_rider_weight_lbs,
        ideal_event_types, indoor_allowed, outdoor_allowed, allowed_surfaces, space_length_ft,
        space_width_ft, space_height_ft, power_outlets_required, power_notes, water_required,
        operator_required, attendants_required, setup_minutes, teardown_minutes, setup_requirements,
        tags, internal_notes, external_source, external_ref
      ) values (
        b.organization_id, v.name, v.slug, v.short_description, v.description,
        coalesce(v.is_published, false), coalesce(v.pricing_type, 'per_event'), v.base_price_cents,
        v.included_duration_minutes, v.minimum_rental_minutes, v.setup_buffer_minutes,
        v.teardown_buffer_minutes, v.overnight_allowed, v.wind_sensitive, v.wind_threshold_mph,
        coalesce(v.wet_allowed, false), coalesce(v.dry_allowed, true), v.minimum_age, v.maximum_age,
        v.recommended_capacity, v.max_rider_weight_lbs, coalesce(v.ideal_event_types, '{}'),
        coalesce(v.indoor_allowed, false), coalesce(v.outdoor_allowed, true),
        coalesce(v.allowed_surfaces, '{}'), v.space_length_ft, v.space_width_ft, v.space_height_ft,
        v.power_outlets_required, v.power_notes, coalesce(v.water_required, false),
        coalesce(v.operator_required, false), coalesce(v.attendants_required, 0), v.setup_minutes,
        v.teardown_minutes, v.setup_requirements, coalesce(v.tags, '{}'), v.internal_notes,
        case when v.external_ref is null then null else b.external_source end, v.external_ref
      )
      returning id into pid;
      n_created := n_created + 1;
    end if;

    -- Categories: link by slug, creating missing ones in this organization.
    if jsonb_typeof(j -> 'categories') = 'array' then
      for cat in select * from jsonb_array_elements(j -> 'categories') loop
        select c.id into cid from public.categories c
        where c.organization_id = b.organization_id and c.slug = cat ->> 'slug';
        if cid is null then
          insert into public.categories (organization_id, name, slug)
          values (b.organization_id, cat ->> 'name', cat ->> 'slug')
          returning id into cid;
        end if;
        insert into public.product_categories (organization_id, product_id, category_id)
        values (b.organization_id, pid, cid)
        on conflict do nothing;
        update public.products set primary_category_id = cid
        where id = pid and primary_category_id is null;
      end loop;
    end if;

    -- Inventory quantity on the default variant. Imports only ever add serialized units.
    select pv.id, pv.tracking_mode into vid, mode
    from public.product_variants pv where pv.product_id = pid and pv.is_default;

    if not existed and j ->> 'tracking_mode' = 'pooled' then
      update public.product_variants
      set tracking_mode = 'pooled', pooled_quantity = coalesce((j ->> 'quantity')::integer, 0)
      where id = vid;
      mode := 'pooled';
    elsif j ? 'quantity' then
      qty := (j ->> 'quantity')::integer;
      if mode = 'pooled' then
        update public.product_variants set pooled_quantity = qty where id = vid;
      else
        select count(*) filter (where u.status = 'active'), count(*) into have, total
        from public.inventory_units u where u.variant_id = vid;
        insert into public.inventory_units (organization_id, variant_id, label)
        select b.organization_id, vid, 'Unit ' || (total + g)
        from generate_series(1, greatest(qty - have, 0)) g;
      end if;
    end if;

    update public.import_rows set target_id = pid where id = r.id;
  end loop;

  v_summary := jsonb_build_object('created', n_created, 'updated', n_updated, 'skipped', n_skipped);
  update public.import_batches
  set status = 'committed', committed_at = now(), summary = v_summary
  where id = b.id;
  return v_summary;
end;
$$;
revoke execute on function public.commit_product_import(uuid) from public, anon;
grant execute on function public.commit_product_import(uuid) to authenticated, service_role;
