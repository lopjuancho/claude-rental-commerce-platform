-- Hardening, round 2 (Codex re-review of ee09fcb). ADR 0014 §7.
--
-- B1  Confirmation re-validates availability. confirm_reservation now re-checks, under the lock
--     protocol, that every held allocation is still bookable (unit active and unblocked, no
--     blackout / product / variant block, enough pooled stock beside other bookings and partial
--     blocks, product still active). A hold that became invalid cannot be confirmed; confirmed
--     bookings are never cancelled (blocks flag them, as before).
-- B2  Weather-rule changes take the lock. The shared organization-lock trigger read OLD, which is
--     NULL on INSERT, so pg_advisory_xact_lock(NULL) silently took no lock: adding a weather rule
--     raced with holds. Fixed; also product_categories (which decides 'selected' weather blocks)
--     and lift_weather_block now lock, and any rule/category change flags the bookings it affects.
-- B3  Add-on status is server-authoritative: pricing_context reports catalog add-on relations and
--     the server derives each item's kind; the client-supplied `kind` is gone from the request.

-- ═════════════════════════════ B2: locking ═════════════════════════════
create or replace function app.lock_organization(p_organization_id uuid, p_exclusive boolean)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  -- A NULL key would make pg_advisory_xact_lock a silent no-op (strict function).
  if p_organization_id is null then
    raise exception 'lock_organization: organization id is required' using errcode = 'RA006';
  end if;
  if p_exclusive then
    perform pg_advisory_xact_lock(hashtextextended('org:' || p_organization_id::text, 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('org:' || p_organization_id::text, 0));
  end if;
end;
$$;

create or replace function app.organization_availability_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- NEW on INSERT/UPDATE, OLD on DELETE. `organizations` has no organization_id column.
  row_json jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  org uuid := coalesce(row_json ->> 'organization_id', row_json ->> 'id')::uuid;
begin
  perform app.lock_organization(org, true);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Category membership decides which products a 'selected' weather block covers.
create function app.product_categories_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  perform app.lock_variants((r ->> 'organization_id')::uuid, array(
    select v.id from public.product_variants v
    where v.product_id in ((r ->> 'product_id')::uuid,
                           case when tg_op = 'UPDATE' then old.product_id end)));
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger product_categories_availability_lock before insert or update or delete on public.product_categories
  for each row execute function app.product_categories_lock();

-- Flags (never cancels) active future allocations that a confirmed weather block now covers.
create function app.flag_weather_conflicts(p_organization_id uuid, p_product_id uuid default null)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with inserted as (
    insert into public.reservation_flags (organization_id, reservation_id, kind, weather_block_id, message)
    select distinct a.organization_id, a.reservation_id, 'weather_block'::public.reservation_flag_kind, w.id,
           'Confirmed ' || replace(w.hazard::text, '_', ' ') || ' block: ' || w.reason
    from public.reservation_allocations a
    join public.product_variants v on v.id = a.variant_id
    join public.weather_blocks w
      on w.organization_id = a.organization_id and w.status = 'confirmed' and w.period && a.rental_period
    where a.organization_id = p_organization_id
      and (p_product_id is null or v.product_id = p_product_id)
      and upper(a.rental_period) > now()
      and app.allocation_is_active(a.status, a.hold_expires_at)
      and w.id in (select app.blocking_weather(v.product_id, a.rental_period))
    on conflict do nothing
    returning 1
  )
  select count(*)::integer from inserted
$$;

create function app.weather_inputs_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  if tg_table_name = 'products' then
    perform app.flag_weather_conflicts(new.organization_id, new.id);
  elsif tg_table_name = 'product_categories' then
    perform app.flag_weather_conflicts((r ->> 'organization_id')::uuid, (r ->> 'product_id')::uuid);
  else
    perform app.flag_weather_conflicts((r ->> 'organization_id')::uuid, null);
  end if;
  return null;
end;
$$;
create trigger weather_hazard_rules_flag after insert or update or delete on public.weather_hazard_rules
  for each row execute function app.weather_inputs_changed();
create trigger product_categories_weather_flag after insert or update or delete on public.product_categories
  for each row execute function app.weather_inputs_changed();
create trigger products_weather_flag after update of primary_category_id on public.products
  for each row execute function app.weather_inputs_changed();

-- Lifting only frees capacity, but it is an organization-wide availability change: serialize it.
create or replace function public.lift_weather_block(p_weather_block_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  w public.weather_blocks;
begin
  select * into w from public.weather_blocks where id = p_weather_block_id;
  if not found or (select auth.uid()) is null or not app.has_permission(w.organization_id, 'availability.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.lock_organization(w.organization_id, true);
  select * into w from public.weather_blocks where id = p_weather_block_id for update;
  if w.status = 'lifted' then
    return;
  end if;
  update public.weather_blocks set status = 'lifted', lifted_by = (select auth.uid()), lifted_at = now() where id = w.id;
end;
$$;

-- ═════════════════════════════ B1: confirmation re-validation ═════════════════════════════
-- Why a held reservation can no longer be confirmed (empty = still valid). Must run with the
-- reservation's variant locks held. The hold never counts against itself.
create function app.hold_invalid_reasons(p_reservation_id uuid, p_actor text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.reservation_allocations;
  ctx record;
  why text[] := '{}';
  usage integer;
begin
  for a in select * from public.reservation_allocations where reservation_id = p_reservation_id loop
    select * into ctx from app.variant_context(a.variant_id);
    if not ctx.variant_active or ctx.product_archived then
      why := array_append(why, 'VARIANT_INACTIVE');
    end if;
    if p_actor = 'system' and (not ctx.product_published or ctx.organization_status <> 'active') then
      why := array_append(why, 'VARIANT_INACTIVE');
    end if;
    if exists (select 1 from public.availability_blocks b
               where b.organization_id = a.organization_id and b.period && a.occupied_period
                 and b.product_id is null and b.variant_id is null and b.inventory_unit_id is null) then
      why := array_append(why, 'BLACKOUT');
    end if;
    if exists (select 1 from public.availability_blocks b
               where b.period && a.occupied_period and b.quantity is null
                 and (b.product_id = ctx.product_id or b.variant_id = a.variant_id)) then
      why := array_append(why, 'PRODUCT_BLOCKED');
    end if;
    if a.inventory_unit_id is not null then
      if exists (select 1 from public.inventory_units u
                 where u.id = a.inventory_unit_id and (u.status <> 'active' or u.variant_id <> a.variant_id))
         or exists (select 1 from public.availability_blocks b
                    where b.inventory_unit_id = a.inventory_unit_id and b.period && a.occupied_period) then
        why := array_append(why, 'UNIT_UNAVAILABLE');
      end if;
    else
      -- Pooled: this hold must still fit beside every other active booking/hold and partial block.
      select app.peak_usage(a.occupied_period, array_agg(x.r), array_agg(x.q)) into usage
      from (
        select o.occupied_period as r, o.quantity as q
        from public.reservation_allocations o
        where o.variant_id = a.variant_id and o.reservation_id <> p_reservation_id
          and o.occupied_period && a.occupied_period
          and app.allocation_is_active(o.status, o.hold_expires_at)
        union all
        select b.period, b.quantity
        from public.availability_blocks b
        where b.variant_id = a.variant_id and b.quantity is not null and b.period && a.occupied_period
      ) x;
      if ctx.tracking_mode <> 'pooled' or coalesce(usage, 0) + a.quantity > coalesce(ctx.pooled_quantity, 0) then
        why := array_append(why, 'INSUFFICIENT_QUANTITY');
      end if;
    end if;
  end loop;
  return array(select distinct x from unnest(why) x order by x);
end;
$$;

create or replace function public.confirm_reservation(p_reservation_id uuid, p_ignore_weather boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.reservations;
  actor text;
  why text[];
begin
  -- Authorize before locking so outsiders cannot use this to probe or stall another tenant.
  select * into r from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  actor := app.assert_can_act(r.organization_id, 'availability.write');
  perform app.lock_reservation_variants(r.id);
  select * into r from public.reservations where id = p_reservation_id for update;
  if r.status <> 'held' then
    raise exception 'INVALID_STATE: reservation is %', r.status using errcode = 'RA006';
  end if;
  if r.hold_expires_at <= now() then
    -- Already inactive (reads ignore it); the next writer or the sweeper marks it released.
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  -- Re-validate: stock may have been blocked, retired or taken since the hold (Codex B1).
  why := app.hold_invalid_reasons(r.id, actor);
  if why = array['INSUFFICIENT_QUANTITY'] then
    raise exception 'INSUFFICIENT_AVAILABILITY' using errcode = 'RA001', detail = 'INSUFFICIENT_QUANTITY';
  elsif cardinality(why) > 0 then
    raise exception 'BLOCKED' using errcode = 'RA002', detail = array_to_string(why, ',');
  end if;
  if not (p_ignore_weather and actor = 'staff') and exists (
    select 1 from public.reservation_allocations a
    join public.product_variants v on v.id = a.variant_id
    where a.reservation_id = r.id and exists (select 1 from app.blocking_weather(v.product_id, a.rental_period))
  ) then
    raise exception 'BLOCKED' using errcode = 'RA002', detail = 'WEATHER_BLOCK';
  end if;
  update public.reservations set status = 'confirmed', hold_expires_at = null, confirmed_at = now() where id = r.id;
end;
$$;

revoke execute on function
  app.product_categories_lock(),
  app.flag_weather_conflicts(uuid, uuid),
  app.weather_inputs_changed(),
  app.hold_invalid_reasons(uuid, text)
from public;

-- ═════════════════════════════ B3: add-on status from the catalog ═════════════════════════════
create or replace function public.pricing_context(p_organization_id uuid, p_variant_ids uuid[])
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
      'id', o.id, 'currency', o.currency, 'timezone', o.timezone, 'status', o.status,
      'multiDayBilling', s.multi_day_billing),
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
        -- Products this one is a catalog add-on of (product_relations 'addon'). Whether a requested
        -- item is priced as an add-on is decided from this, never by the caller.
        'addonOf', coalesce((select jsonb_agg(r.product_id order by r.product_id) from public.product_relations r
                             where r.related_product_id = p.id and r.relation_type = 'addon'
                               and r.organization_id = p.organization_id), '[]'::jsonb),
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
