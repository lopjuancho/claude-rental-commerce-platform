-- Milestone 3 (pre-work) · Tenant branding, policy placeholders, and hazard-generic weather rules.
-- ADR 0010 (revised): weather is not only wind. Sensitivity and thresholds are per hazard and
-- resolved product → primary category → organization. Nothing here is tenant-specific.

-- ───────────────────────────── branding ─────────────────────────────
alter table public.organization_settings
  add column accent_color text check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  add column logo_mark_media_path text,
  add column favicon_media_path text,
  add constraint organization_settings_brand_paths check (
    (logo_media_path is null or logo_media_path like organization_id::text || '/%')
    and (logo_mark_media_path is null or logo_mark_media_path like organization_id::text || '/%')
    and (favicon_media_path is null or favicon_media_path like organization_id::text || '/%')
  );

-- Brand assets are public by nature (shown on the storefront); writes stay tenant-scoped.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-assets', 'brand-assets', true, 2097152,
        array['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon'])
on conflict (id) do nothing;

create policy brand_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'brand-assets'
              and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'settings.write')));
create policy brand_assets_update on storage.objects for update to authenticated
  using (bucket_id = 'brand-assets'
         and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'settings.write')))
  with check (bucket_id = 'brand-assets'
              and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'settings.write')));
create policy brand_assets_delete on storage.objects for delete to authenticated
  using (bucket_id = 'brand-assets'
         and (select app.has_permission(app.try_uuid((storage.foldername(name))[1]), 'settings.write')));

-- Tenant resolution now returns the full public brand profile.
drop function public.resolve_organization_by_host(text);
drop function public.resolve_organization_by_slug(text);

create function app.public_organization_profile(p_organization_id uuid)
returns table (
  id uuid, slug text, name text, timezone text, currency char(3),
  logo_media_path text, logo_mark_media_path text, favicon_media_path text,
  primary_color text, secondary_color text, accent_color text,
  contact_phone text, sms_phone text, contact_email text, website_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.slug, o.name, o.timezone, o.currency,
         s.logo_media_path, s.logo_mark_media_path, s.favicon_media_path,
         s.primary_color, s.secondary_color, s.accent_color,
         s.contact_phone, s.sms_phone, s.contact_email::text, s.website_url
  from public.organizations o
  join public.organization_settings s on s.organization_id = o.id
  where o.id = p_organization_id and o.status = 'active'
$$;

create function public.resolve_organization_by_host(p_host text)
returns table (
  id uuid, slug text, name text, timezone text, currency char(3),
  logo_media_path text, logo_mark_media_path text, favicon_media_path text,
  primary_color text, secondary_color text, accent_color text,
  contact_phone text, sms_phone text, contact_email text, website_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.organization_domains d
  cross join lateral app.public_organization_profile(d.organization_id) p
  where d.hostname = lower(p_host)::extensions.citext
  limit 1
$$;

create function public.resolve_organization_by_slug(p_slug text)
returns table (
  id uuid, slug text, name text, timezone text, currency char(3),
  logo_media_path text, logo_mark_media_path text, favicon_media_path text,
  primary_color text, secondary_color text, accent_color text,
  contact_phone text, sms_phone text, contact_email text, website_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.organizations o
  cross join lateral app.public_organization_profile(o.id) p
  where o.slug = lower(p_slug)
  limit 1
$$;

revoke execute on function app.public_organization_profile(uuid) from public;
revoke execute on function public.resolve_organization_by_host(text), public.resolve_organization_by_slug(text)
  from public;
grant execute on function public.resolve_organization_by_host(text), public.resolve_organization_by_slug(text)
  to anon, authenticated, service_role;

-- ───────────────────────────── policies ─────────────────────────────
alter table public.organization_policies drop constraint organization_policies_policy_type_check;
alter table public.organization_policies
  add constraint organization_policies_policy_type_check check (policy_type in (
    'weather', 'wind_safety', 'cancellation', 'overnight', 'delivery', 'setup_requirements',
    'power_requirements', 'water_requirements', 'supervision', 'operator_requirements',
    'deposit', 'safety', 'other')),
  add column is_placeholder boolean not null default false,
  -- Placeholder text can never reach customers or the assistant.
  add constraint organization_policies_placeholder_unpublished check (not (is_placeholder and is_published));

-- Editing the wording turns a placeholder into a real (still unpublished) policy.
create function app.policies_clear_placeholder()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_placeholder and new.body is distinct from old.body and new.is_placeholder = old.is_placeholder then
    new.is_placeholder := false;
  end if;
  return new;
end;
$$;
revoke execute on function app.policies_clear_placeholder() from public;
create trigger organization_policies_clear_placeholder before update on public.organization_policies
  for each row execute function app.policies_clear_placeholder();

-- ───────────────────────────── weather hazard rules ─────────────────────────────
create type public.weather_hazard as enum ('wind', 'lightning', 'rain', 'severe_weather', 'temperature', 'custom');

create table public.weather_hazard_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- scope: neither = organization default; category or product = override
  category_id     uuid,
  product_id      uuid,
  hazard          public.weather_hazard not null,
  -- false = explicitly NOT affected (e.g. a trackless train and wind)
  sensitive       boolean not null,
  -- Operating limit, e.g. 15 mph wind or 100 °F. Null = sensitive with no numeric limit (any block applies).
  threshold_value numeric(6, 2) check (threshold_value > 0),
  threshold_unit  text check (threshold_unit in ('mph', 'kph', 'fahrenheit', 'celsius', 'inches_per_hour')),
  notes           text check (length(notes) <= 1000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (num_nonnulls(category_id, product_id) <= 1),
  check ((threshold_value is null) = (threshold_unit is null)),
  unique nulls not distinct (organization_id, category_id, product_id, hazard),
  foreign key (organization_id, category_id) references public.categories (organization_id, id) on delete cascade,
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade
);
create index weather_hazard_rules_org_idx on public.weather_hazard_rules (organization_id, hazard);

-- Carry any M2 wind configuration over before removing the wind-only columns.
insert into public.weather_hazard_rules (organization_id, hazard, sensitive, threshold_value, threshold_unit)
select organization_id, 'wind', true, wind_threshold_mph, 'mph'
from public.organization_settings where wind_threshold_mph is not null;
insert into public.weather_hazard_rules (organization_id, category_id, hazard, sensitive, threshold_value, threshold_unit)
select organization_id, id, 'wind', coalesce(wind_sensitive, true), wind_threshold_mph,
       case when wind_threshold_mph is null then null else 'mph' end
from public.categories where wind_sensitive is not null or wind_threshold_mph is not null;
insert into public.weather_hazard_rules (organization_id, product_id, hazard, sensitive, threshold_value, threshold_unit)
select organization_id, id, 'wind', coalesce(wind_sensitive, true), wind_threshold_mph,
       case when wind_threshold_mph is null then null else 'mph' end
from public.products where wind_sensitive is not null or wind_threshold_mph is not null;

drop view public.public_catalog_products;
alter table public.organization_settings drop column wind_threshold_mph;
alter table public.categories drop column wind_sensitive, drop column wind_threshold_mph;
alter table public.products drop column wind_sensitive, drop column wind_threshold_mph;

create trigger weather_hazard_rules_updated_at before update on public.weather_hazard_rules
  for each row execute function app.set_updated_at();
create trigger weather_hazard_rules_org_immutable before update on public.weather_hazard_rules
  for each row execute function app.prevent_organization_change();
create trigger audit_weather_hazard_rules after insert or update or delete on public.weather_hazard_rules
  for each row execute function app.audit_row_change('weather_rule');

alter table public.weather_hazard_rules enable row level security;
alter table public.weather_hazard_rules force row level security;
revoke all on public.weather_hazard_rules from anon;
create policy weather_hazard_rules_select on public.weather_hazard_rules for select to authenticated
  using ((select app.has_permission(organization_id, 'org.read')));
create policy weather_hazard_rules_insert on public.weather_hazard_rules for insert to authenticated
  with check ((select app.has_permission(organization_id, 'catalog.write')));
create policy weather_hazard_rules_update on public.weather_hazard_rules for update to authenticated
  using ((select app.has_permission(organization_id, 'catalog.write')))
  with check ((select app.has_permission(organization_id, 'catalog.write')));
create policy weather_hazard_rules_delete on public.weather_hazard_rules for delete to authenticated
  using ((select app.has_permission(organization_id, 'catalog.write')));

-- Effective rules for a product: the most specific level wins per hazard (product → primary
-- category → organization). A threshold is inherited from a less specific level when the winning
-- level declares sensitivity without one. Mirrored in src/domain/weather/resolve.ts.
create function app.product_hazard_rules(p_product_id uuid)
returns table (hazard public.weather_hazard, sensitive boolean, threshold_value numeric, threshold_unit text)
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select id, organization_id, primary_category_id from public.products where id = p_product_id
  ),
  ranked as (
    select r.hazard, r.sensitive, r.threshold_value, r.threshold_unit,
           case when r.product_id is not null then 1 when r.category_id is not null then 2 else 3 end as lvl
    from public.weather_hazard_rules r
    join p on r.organization_id = p.organization_id
    where r.product_id = p.id
       or (r.category_id = p.primary_category_id and r.product_id is null)
       or (r.category_id is null and r.product_id is null)
  )
  select h.hazard,
         (select x.sensitive from ranked x where x.hazard = h.hazard order by x.lvl limit 1),
         (select x.threshold_value from ranked x where x.hazard = h.hazard and x.threshold_value is not null order by x.lvl limit 1),
         (select x.threshold_unit from ranked x where x.hazard = h.hazard and x.threshold_value is not null order by x.lvl limit 1)
  from (select distinct hazard from ranked) h
$$;
-- Internal (unfiltered): used by availability functions, which run as owner.
revoke execute on function app.product_hazard_rules(uuid) from public;

-- Public wrapper for the catalog view. Functions inside views are permission-checked as the
-- caller, so this is what anon executes; it only answers for published products of active orgs.
create function app.public_product_hazard_rules(p_product_id uuid)
returns table (hazard public.weather_hazard, sensitive boolean, threshold_value numeric, threshold_unit text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from public.products p
  join public.organizations o on o.id = p.organization_id
  cross join lateral app.product_hazard_rules(p.id) r
  where p.id = p_product_id and p.is_published and p.archived_at is null and o.status = 'active'
$$;
revoke execute on function app.public_product_hazard_rules(uuid) from public;
grant execute on function app.public_product_hazard_rules(uuid) to anon, authenticated, service_role;

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
  coalesce((
    select jsonb_agg(jsonb_build_object('hazard', r.hazard, 'threshold_value', r.threshold_value, 'threshold_unit', r.threshold_unit)
                     order by r.hazard)
    from app.public_product_hazard_rules(p.id) r where r.sensitive
  ), '[]'::jsonb) as weather_sensitivities,
  array(
    select pcat.category_id from public.product_categories pcat
    join public.categories cat on cat.id = pcat.category_id
    where pcat.product_id = p.id and cat.is_published and cat.archived_at is null
  ) as category_ids
from public.products p
join public.organizations o on o.id = p.organization_id
where o.status = 'active' and p.is_published and p.archived_at is null;

revoke all on public.public_catalog_products from anon, authenticated;
grant select on public.public_catalog_products to anon, authenticated, service_role;

-- ───────────────────────────── import commit ─────────────────────────────
-- Same function as before, with the product-level wind column replaced by a hazard rule.
create or replace function public.commit_product_import(p_batch_id uuid)
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
  total integer;
  mode public.tracking_mode;
  n_created integer := 0;
  n_updated integer := 0;
  n_skipped integer := 0;
  v_summary jsonb;
begin
  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'import batch not found' using errcode = 'no_data_found';
  end if;
  if b.status <> 'validated' then
    raise exception 'import batch must be validated before commit (status: %)', b.status
      using errcode = 'check_violation';
  end if;

  for r in select * from public.import_rows where batch_id = b.id order by row_number loop
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
        teardown_buffer_minutes, overnight_allowed, wet_allowed, dry_allowed, minimum_age, maximum_age,
        recommended_capacity, max_rider_weight_lbs, ideal_event_types, indoor_allowed, outdoor_allowed,
        allowed_surfaces, space_length_ft, space_width_ft, space_height_ft, power_outlets_required,
        power_notes, water_required, operator_required, attendants_required, setup_minutes,
        teardown_minutes, setup_requirements, tags, internal_notes, external_source, external_ref
      ) values (
        b.organization_id, v.name, v.slug, v.short_description, v.description,
        coalesce(v.is_published, false), coalesce(v.pricing_type, 'per_event'), v.base_price_cents,
        v.included_duration_minutes, v.minimum_rental_minutes, v.setup_buffer_minutes,
        v.teardown_buffer_minutes, v.overnight_allowed,
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

    -- Product-level wind rule when the source says so (other hazards are configured in the admin).
    if jsonb_typeof(j -> 'wind_sensitive') = 'boolean' then
      insert into public.weather_hazard_rules (organization_id, product_id, hazard, sensitive)
      values (b.organization_id, pid, 'wind', (j ->> 'wind_sensitive')::boolean)
      on conflict (organization_id, category_id, product_id, hazard)
      do update set sensitive = excluded.sensitive;
    end if;

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
