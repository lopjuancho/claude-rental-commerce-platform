-- Milestone 4 · Pricing rules, delivery service areas, distance cache, tax configuration, and
-- immutable pricing calculations. Design: ADR 0013 (pricing engine), ADR 0009 (delivery),
-- ADR 0004 (tax). The price itself is computed by ONE deterministic engine
-- (src/domain/pricing); the database supplies its inputs and stores immutable snapshots.

-- ───────────────────────────── pricing rules ─────────────────────────────
create type public.pricing_rule_type as enum (
  'extra_hour',        -- {amount_cents, increment_minutes?}   per started increment beyond included duration
  'overnight',         -- {amount_cents} | {percent_of_base_bps}  single-day rental crossing local midnight
  'additional_day',    -- {amount_cents} | {percent_of_base_bps}  per day beyond the first (multi-day rentals)
  'attendant_fee',     -- {amount_cents, per: 'event'|'hour'}      per required attendant
  'fee',               -- {amount_cents, per: 'order'|'unit', label?}
  'discount_percent',  -- {percent_bps, min_quantity?}
  'discount_fixed',    -- {amount_cents}
  'minimum_charge'     -- {amount_cents}                          order-level rental minimum
);

create table public.pricing_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 120),
  rule_type       public.pricing_rule_type not null,
  -- scope: none = organization-wide; otherwise exactly one (most specific wins, ADR 0003)
  category_id     uuid,
  product_id      uuid,
  variant_id      uuid,
  params          jsonb not null check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 2048),
  priority        integer not null default 0,
  discount_code   extensions.citext check (discount_code is null or discount_code ~ '^[A-Za-z0-9_-]{2,40}$'),
  valid_from      date,
  valid_to        date,
  is_active       boolean not null default true,
  -- Incremented on every change; snapshots record (id, revision) so edits never rewrite history.
  revision        integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name),
  check (num_nonnulls(category_id, product_id, variant_id) <= 1),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  check (discount_code is null or rule_type in ('discount_percent', 'discount_fixed')),
  -- Parameter shape per type (the TypeScript schema validates the same shapes).
  check (case rule_type
    when 'extra_hour' then (params ? 'amount_cents')
    when 'overnight' then ((params ? 'amount_cents') <> (params ? 'percent_of_base_bps'))
    when 'additional_day' then ((params ? 'amount_cents') <> (params ? 'percent_of_base_bps'))
    when 'attendant_fee' then (params ? 'amount_cents' and params ->> 'per' in ('event', 'hour'))
    when 'fee' then (params ? 'amount_cents' and params ->> 'per' in ('order', 'unit'))
    when 'discount_percent' then (params ? 'percent_bps')
    when 'discount_fixed' then (params ? 'amount_cents')
    when 'minimum_charge' then (params ? 'amount_cents')
  end),
  foreign key (organization_id, category_id) references public.categories (organization_id, id) on delete cascade,
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade,
  foreign key (organization_id, variant_id) references public.product_variants (organization_id, id) on delete cascade
);
create index pricing_rules_org_idx on public.pricing_rules (organization_id, rule_type) where is_active;

create function app.bump_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if to_jsonb(new) - 'revision' - 'updated_at' is distinct from to_jsonb(old) - 'revision' - 'updated_at' then
    new.revision := old.revision + 1;
  else
    new.revision := old.revision;
  end if;
  return new;
end;
$$;
revoke execute on function app.bump_revision() from public;
create trigger pricing_rules_revision before update on public.pricing_rules
  for each row execute function app.bump_revision();

-- ───────────────────────────── service areas ─────────────────────────────
-- Where delivery is offered and how it is priced. With no areas configured, organization mileage
-- settings apply everywhere (subject to maximum_delivery_miles). With areas configured, an address
-- must match one; otherwise delivery needs manual review (ADR 0009).
create type public.service_area_pricing as enum ('flat', 'mileage', 'manual_review');

create table public.service_areas (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  name                text not null check (length(btrim(name)) between 1 and 120),
  pricing             public.service_area_pricing not null default 'mileage',
  flat_fee_cents      bigint check (flat_fee_cents >= 0),
  priority            integer not null default 0,
  is_active           boolean not null default true,
  revision            integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name),
  check ((pricing = 'flat') = (flat_fee_cents is not null))
);

create table public.service_area_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  service_area_id uuid not null,
  rule_type       text not null check (rule_type in ('postal_code', 'city')),
  postal_code     text check (postal_code ~ '^\d{5}$'),
  city            extensions.citext,
  state           text check (state ~ '^[A-Z]{2}$'),
  foreign key (organization_id, service_area_id) references public.service_areas (organization_id, id) on delete cascade,
  check ((rule_type = 'postal_code' and postal_code is not null and city is null)
      or (rule_type = 'city' and city is not null and state is not null and postal_code is null))
);
create index service_area_rules_area_idx on public.service_area_rules (service_area_id);

create trigger service_areas_revision before update on public.service_areas
  for each row execute function app.bump_revision();

-- ───────────────────────────── distance cache ─────────────────────────────
create table public.delivery_distance_cache (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  provider         text not null check (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_version text not null check (length(provider_version) between 1 and 40),
  route_key        text not null check (route_key ~ '^[0-9a-f]{64}$'),  -- sha256(normalized origin|destination)
  meters           integer not null check (meters >= 0),
  fetched_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  primary key (organization_id, provider, provider_version, route_key),
  check (expires_at > fetched_at)
);

-- ───────────────────────────── tax ─────────────────────────────
create type public.tax_component as enum ('rental', 'add_on', 'delivery', 'labor', 'fee', 'discount', 'adjustment');
create type public.tax_jurisdiction_status as enum ('test', 'active');

create table public.tax_jurisdictions (
  id                           uuid primary key default gen_random_uuid(),
  organization_id              uuid not null references public.organizations (id) on delete cascade,
  name                         text not null check (length(btrim(name)) between 1 and 120),
  state                        text not null check (state ~ '^[A-Z]{2}$'),
  -- Empty = the whole state. Phase 1 matches by ZIP; an address-level provider can replace this.
  postal_codes                 text[] not null default '{}',
  requires_review_postal_codes text[] not null default '{}',
  -- 'test' rates may be used to exercise the engine but always force manual review.
  status                       public.tax_jurisdiction_status not null default 'test',
  priority                     integer not null default 0,
  is_active                    boolean not null default true,
  revision                     integer not null default 1,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name)
);

create table public.tax_rates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  jurisdiction_id  uuid not null,
  name             text not null check (length(btrim(name)) between 1 and 120),
  rate_bps         integer not null check (rate_bps between 0 and 5000),   -- basis points ×100: 975 = 9.75 %
  valid_from       date,
  valid_to         date,
  created_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, jurisdiction_id) references public.tax_jurisdictions (organization_id, id) on delete cascade,
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table public.tax_component_rules (
  organization_id uuid not null,
  jurisdiction_id uuid not null,
  component       public.tax_component not null,
  -- For 'discount'/'adjustment': true = the (negative) amount reduces the taxable base.
  taxable         boolean not null,
  primary key (jurisdiction_id, component),
  foreign key (organization_id, jurisdiction_id) references public.tax_jurisdictions (organization_id, id) on delete cascade
);

create trigger tax_jurisdictions_revision before update on public.tax_jurisdictions
  for each row execute function app.bump_revision();

-- ───────────────────────────── pricing calculations (snapshots) ─────────────────────────────
-- Immutable record of one engine run: exactly what went in, what came out, which rules (and
-- which revisions) applied, and the engine version. Quotes (M5) reference these; editing a rule
-- or a product price later never changes a stored calculation.
create table public.pricing_calculations (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  engine_version         text not null,
  input                  jsonb not null,
  output                 jsonb not null,
  input_hash             text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  currency               char(3) not null,
  total_cents            bigint not null,
  manual_review_required boolean not null,
  created_by_type        public.audit_actor_type not null,
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  unique (organization_id, id)
);
create index pricing_calculations_org_idx on public.pricing_calculations (organization_id, created_at desc);

create function app.pricing_calculations_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.organization_id) then
    return old;  -- organization deletion cascade
  end if;
  raise exception 'pricing calculations are immutable' using errcode = 'insufficient_privilege';
end;
$$;
revoke execute on function app.pricing_calculations_immutable() from public;
create trigger pricing_calculations_no_update before update or delete on public.pricing_calculations
  for each row execute function app.pricing_calculations_immutable();

-- ───────────────────────────── triggers, RLS ─────────────────────────────
create trigger pricing_rules_updated_at before update on public.pricing_rules for each row execute function app.set_updated_at();
create trigger service_areas_updated_at before update on public.service_areas for each row execute function app.set_updated_at();
create trigger tax_jurisdictions_updated_at before update on public.tax_jurisdictions for each row execute function app.set_updated_at();

create trigger audit_pricing_rules after insert or update or delete on public.pricing_rules
  for each row execute function app.audit_row_change('pricing_rule');
create trigger audit_service_areas after insert or update or delete on public.service_areas
  for each row execute function app.audit_row_change('service_area');
create trigger audit_tax_jurisdictions after insert or update or delete on public.tax_jurisdictions
  for each row execute function app.audit_row_change('tax_jurisdiction');
create trigger audit_tax_rates after insert or update or delete on public.tax_rates
  for each row execute function app.audit_row_change('tax_rate');
create trigger audit_tax_component_rules after insert or update or delete on public.tax_component_rules
  for each row execute function app.audit_row_change('tax_rule');

do $$
declare
  t text;
begin
  foreach t in array array['pricing_rules', 'service_areas', 'service_area_rules', 'tax_jurisdictions',
                           'tax_rates', 'tax_component_rules', 'delivery_distance_cache', 'pricing_calculations'] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.prevent_organization_change()', t || '_org_immutable', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format($p$create policy %I on public.%I for select to authenticated
                     using ((select app.has_permission(organization_id, 'org.read')))$p$, t || '_select', t);
  end loop;
  -- Pricing configuration: pricing.write (owner/admin).
  foreach t in array array['pricing_rules', 'service_areas', 'service_area_rules', 'tax_jurisdictions',
                           'tax_rates', 'tax_component_rules'] loop
    execute format($p$create policy %I on public.%I for insert to authenticated
                     with check ((select app.has_permission(organization_id, 'pricing.write')))$p$, t || '_insert', t);
    execute format($p$create policy %I on public.%I for update to authenticated
                     using ((select app.has_permission(organization_id, 'pricing.write')))
                     with check ((select app.has_permission(organization_id, 'pricing.write')))$p$, t || '_update', t);
    execute format($p$create policy %I on public.%I for delete to authenticated
                     using ((select app.has_permission(organization_id, 'pricing.write')))$p$, t || '_delete', t);
  end loop;
end $$;

-- `revision` is owned by app.bump_revision(): writing it directly has no effect.
-- The cache and calculations are written only through the functions below.
revoke insert, update, delete on public.delivery_distance_cache, public.pricing_calculations from authenticated;

-- ───────────────────────────── API functions ─────────────────────────────

-- Everything the pricing engine needs for these variants, with the ADR 0003 chain resolved.
-- Pure data: the engine decides. Callable by staff of the organization or the system context.
create function public.pricing_context(p_organization_id uuid, p_variant_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform app.assert_can_act(p_organization_id, 'org.read');
  if cardinality(p_variant_ids) > 50 then
    raise exception 'INVALID_REQUEST: too many items' using errcode = 'RA006';
  end if;

  select jsonb_build_object(
    'organization', jsonb_build_object(
      'id', o.id, 'currency', o.currency, 'timezone', o.timezone, 'status', o.status),
    'delivery', jsonb_build_object(
      'depot', case when s.primary_depot_address_line1 is null then null else jsonb_build_object(
        'line1', s.primary_depot_address_line1, 'city', s.primary_depot_city,
        'state', s.primary_depot_state, 'postalCode', s.primary_depot_postal_code) end,
      'freeMiles', s.free_delivery_miles, 'perMileRateCents', s.per_mile_rate_cents,
      'maximumMiles', s.maximum_delivery_miles, 'rounding', s.mileage_rounding_method, 'basis', s.mileage_basis),
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variantId', v.id, 'productId', p.id,
        'name', case when v.is_default then p.name else p.name || ' — ' || v.name end,
        'primaryCategoryId', p.primary_category_id,
        'categoryIds', coalesce((select jsonb_agg(pc.category_id order by pc.category_id) from public.product_categories pc where pc.product_id = p.id), '[]'::jsonb),
        'basePriceCents', coalesce(v.price_override_cents, p.base_price_cents),
        'includedDurationMinutes', coalesce(p.included_duration_minutes, c.included_duration_minutes, s.default_rental_duration_minutes),
        'overnightAllowed', coalesce(p.overnight_allowed, c.overnight_allowed, s.overnight_allowed),
        'attendantsRequired', p.attendants_required,
        'published', p.is_published and p.archived_at is null,
        'active', v.is_active and v.archived_at is null and p.archived_at is null
      ) order by v.id)
      from public.product_variants v
      join public.products p on p.id = v.product_id
      left join public.categories c on c.id = p.primary_category_id
      where v.organization_id = o.id and v.id = any (p_variant_ids)
    ), '[]'::jsonb),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'revision', r.revision, 'name', r.name, 'type', r.rule_type,
        'categoryId', r.category_id, 'productId', r.product_id, 'variantId', r.variant_id,
        'params', r.params, 'priority', r.priority, 'discountCode', r.discount_code::text,
        'validFrom', r.valid_from, 'validTo', r.valid_to
      ) order by r.id)
      from public.pricing_rules r where r.organization_id = o.id and r.is_active
    ), '[]'::jsonb)
  )
  into result
  from public.organizations o
  join public.organization_settings s on s.organization_id = o.id
  where o.id = p_organization_id;
  return result;
end;
$$;

-- Tax configuration for an event address (jurisdiction by state + ZIP; most specific wins).
create function public.tax_context(p_organization_id uuid, p_state text, p_postal_code text, p_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  j public.tax_jurisdictions;
begin
  perform app.assert_can_act(p_organization_id, 'org.read');
  select * into j
  from public.tax_jurisdictions t
  where t.organization_id = p_organization_id and t.is_active and t.state = upper(p_state)
    and (cardinality(t.postal_codes) = 0 or left(p_postal_code, 5) = any (t.postal_codes))
  order by (cardinality(t.postal_codes) > 0) desc, t.priority desc, t.id
  limit 1;
  if not found then
    return jsonb_build_object('status', 'unresolved');
  end if;
  return jsonb_build_object(
    'status', 'resolved',
    'jurisdiction', jsonb_build_object('id', j.id, 'revision', j.revision, 'name', j.name, 'status', j.status,
                                       'boundaryReview', left(p_postal_code, 5) = any (j.requires_review_postal_codes)),
    'rates', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'rateBps', r.rate_bps) order by r.name, r.id)
                       from public.tax_rates r
                       where r.jurisdiction_id = j.id
                         and (r.valid_from is null or r.valid_from <= p_on)
                         and (r.valid_to is null or r.valid_to >= p_on)), '[]'::jsonb),
    'taxability', coalesce((select jsonb_object_agg(c.component, c.taxable) from public.tax_component_rules c where c.jurisdiction_id = j.id), '{}'::jsonb)
  );
end;
$$;

-- Service area matching for an address (ZIP rules before city rules; then priority).
create function public.delivery_area_context(p_organization_id uuid, p_city text, p_state text, p_postal_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  area record;
  any_configured boolean;
begin
  perform app.assert_can_act(p_organization_id, 'org.read');
  select exists (select 1 from public.service_areas a where a.organization_id = p_organization_id and a.is_active) into any_configured;
  select a.id, a.revision, a.name, a.pricing, a.flat_fee_cents into area
  from public.service_areas a
  join public.service_area_rules r on r.service_area_id = a.id
  where a.organization_id = p_organization_id and a.is_active
    and ((r.rule_type = 'postal_code' and r.postal_code = left(p_postal_code, 5))
         or (r.rule_type = 'city' and r.city = p_city::extensions.citext and r.state = upper(p_state)))
  order by (r.rule_type = 'postal_code') desc, a.priority desc, a.id
  limit 1;
  return jsonb_build_object(
    'areasConfigured', any_configured,
    'match', case when area.id is null then null else jsonb_build_object(
      'id', area.id, 'revision', area.revision, 'name', area.name, 'pricing', area.pricing, 'flatFeeCents', area.flat_fee_cents) end);
end;
$$;

create function public.get_cached_distance(p_organization_id uuid, p_provider text, p_provider_version text, p_route_key text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_can_act(p_organization_id, 'org.read');
  return (select c.meters from public.delivery_distance_cache c
          where c.organization_id = p_organization_id and c.provider = p_provider
            and c.provider_version = p_provider_version and c.route_key = p_route_key and c.expires_at > now());
end;
$$;

create function public.put_cached_distance(p_organization_id uuid, p_provider text, p_provider_version text,
                                           p_route_key text, p_meters integer, p_ttl_days integer default 30)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.assert_can_act(p_organization_id, 'org.read');
  if p_ttl_days not between 1 and 30 then
    raise exception 'INVALID_REQUEST: ttl' using errcode = 'RA006';
  end if;
  insert into public.delivery_distance_cache (organization_id, provider, provider_version, route_key, meters, expires_at)
  values (p_organization_id, p_provider, p_provider_version, p_route_key, p_meters, now() + make_interval(days => p_ttl_days))
  on conflict (organization_id, provider, provider_version, route_key)
  do update set meters = excluded.meters, fetched_at = now(), expires_at = excluded.expires_at;
end;
$$;

-- Persists one engine run. Staff need quotes.write; the system context (public/AI flows) may too.
create function public.record_pricing_calculation(
  p_organization_id uuid, p_engine_version text, p_input jsonb, p_output jsonb, p_input_hash text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := app.assert_can_act(p_organization_id, 'quotes.write');
  v_id uuid;
begin
  if pg_column_size(p_input) + pg_column_size(p_output) > 262144 then
    raise exception 'INVALID_REQUEST: calculation too large' using errcode = 'RA006';
  end if;
  insert into public.pricing_calculations (organization_id, engine_version, input, output, input_hash, currency,
                                           total_cents, manual_review_required, created_by_type, created_by)
  values (p_organization_id, p_engine_version, p_input, p_output, p_input_hash,
          p_output ->> 'currency', (p_output #>> '{summary,total}')::bigint,
          (p_output ->> 'manualReviewRequired')::boolean,
          case when actor = 'staff' then 'user' else 'system' end::public.audit_actor_type,
          (select auth.uid()))
  returning pricing_calculations.id into v_id;
  return v_id;
end;
$$;

revoke execute on function
  public.pricing_context(uuid, uuid[]),
  public.tax_context(uuid, text, text, date),
  public.delivery_area_context(uuid, text, text, text),
  public.get_cached_distance(uuid, text, text, text),
  public.put_cached_distance(uuid, text, text, text, integer, integer),
  public.record_pricing_calculation(uuid, text, jsonb, jsonb, text)
from public, anon;
grant execute on function
  public.pricing_context(uuid, uuid[]),
  public.tax_context(uuid, text, text, date),
  public.delivery_area_context(uuid, text, text, text),
  public.get_cached_distance(uuid, text, text, text),
  public.put_cached_distance(uuid, text, text, text, integer, integer),
  public.record_pricing_calculation(uuid, text, jsonb, jsonb, text)
to authenticated, service_role;
