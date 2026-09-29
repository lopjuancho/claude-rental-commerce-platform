-- Hardening milestone (independent review findings, 2026-09-30). ADR 0014.
--
-- H1  One locking protocol for everything that can change availability. Before, only
--     reserve_inventory serialized on per-variant locks; inventory, blocks, deactivation, weather
--     confirmation, hold confirmation and renewal did not, so a hold could race a capacity change.
-- H2  Pricing calculations can only be written by trusted server code (service role). Staff could
--     previously call record_pricing_calculation with any output JSON.
-- H3  Distance-cache entries can only be written by trusted server code. Any member (even the
--     read-only staff role) could previously call put_cached_distance.
-- H4  app.local_to_instant(): local date/time → instant that rejects nonexistent (spring-forward)
--     times and resolves ambiguous (fall-back) times only by an explicit choice.
--
-- New SQLSTATE: RA011 CAPACITY_IN_USE, RA012 INVALID_LOCAL_TIME.

-- ═════════════════════════════ H1: availability lock protocol ═════════════════════════════
--
-- Two levels, always acquired in this order (so there are no lock-order deadlocks):
--   1. organization lock  — SHARED by anything scoped to specific variants;
--                           EXCLUSIVE by organization-wide changes (blackouts, weather confirmation,
--                           settings, categories, weather rules).
--   2. variant locks      — EXCLUSIVE, one per affected variant, in uuid order.
-- Reservation row locks are taken only after the advisory locks.
-- Every check that depends on capacity runs in a statement that starts after the locks are held,
-- so it sees everything committed by the previous holder (READ COMMITTED, fresh snapshot per
-- statement in volatile functions).

create function app.lock_organization(p_organization_id uuid, p_exclusive boolean)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_exclusive then
    perform pg_advisory_xact_lock(hashtextextended('org:' || p_organization_id::text, 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('org:' || p_organization_id::text, 0));
  end if;
end;
$$;

create function app.lock_variants(p_organization_id uuid, p_variant_ids uuid[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  vid uuid;
begin
  perform app.lock_organization(p_organization_id, false);
  for vid in select distinct x from unnest(p_variant_ids) x where x is not null order by x loop
    perform pg_advisory_xact_lock(hashtextextended('variant:' || vid::text, 0));
  end loop;
end;
$$;

-- Future use of a pooled variant at its busiest moment: confirmed bookings + live holds. With
-- p_include_blocks, units under partial blocks (repair, staff holds) are added at every moment
-- where something is booked — blocks alone may cover all stock, but a booking must always fit
-- beside them.
create function app.future_peak_usage(p_variant_id uuid, p_include_blocks boolean default false)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with iv as (
    select tstzrange(now(), 'infinity') * a.occupied_period as r, a.quantity as qa, 0 as qb
    from public.reservation_allocations a
    where a.variant_id = p_variant_id and upper(a.occupied_period) > now()
      and app.allocation_is_active(a.status, a.hold_expires_at)
    union all
    select tstzrange(now(), 'infinity') * b.period, 0, b.quantity
    from public.availability_blocks b
    where p_include_blocks and b.variant_id = p_variant_id and b.quantity is not null and upper(b.period) > now()
  ),
  ev as (
    select lower(r) as t, qa as da, qb as db from iv where not isempty(r)
    union all
    select upper(r), -qa, -qb from iv where not isempty(r)
  ),
  running as (
    select sum(da) over w as booked, sum(db) over w as blocked
    from ev
    window w as (order by t, da + db rows between unbounded preceding and current row)
  )
  select coalesce(max(booked + blocked) filter (where booked > 0), 0)::integer from running
$$;

create function app.unit_has_future_use(p_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.reservation_allocations a
                 where a.inventory_unit_id = p_unit_id and upper(a.occupied_period) > now()
                   and app.allocation_is_active(a.status, a.hold_expires_at))
$$;

-- ── variants: quantity, tracking mode, activation, buffers ──
create function app.variants_capacity_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  peak integer;
begin
  perform app.lock_variants(old.organization_id, array[old.id]);
  if new.tracking_mode is distinct from old.tracking_mode and (
       (old.tracking_mode = 'pooled' and app.future_peak_usage(old.id) > 0)
       or (old.tracking_mode = 'serialized' and exists (
             select 1 from public.inventory_units u where u.variant_id = old.id and app.unit_has_future_use(u.id)))) then
    raise exception 'CAPACITY_IN_USE: tracking mode cannot change while bookings or holds exist'
      using errcode = 'RA011';
  end if;
  -- A reduction must still cover every booking/hold plus units already blocked at the same time.
  if new.tracking_mode = 'pooled' and old.tracking_mode = 'pooled'
     and coalesce(new.pooled_quantity, 0) < coalesce(old.pooled_quantity, 0) then
    peak := app.future_peak_usage(old.id, true);
    if coalesce(new.pooled_quantity, 0) < peak then
      raise exception 'CAPACITY_IN_USE' using errcode = 'RA011',
        detail = format('%s units are booked, held or blocked at the busiest future time', peak);
    end if;
  end if;
  return new;
end;
$$;
create trigger product_variants_capacity_guard before update on public.product_variants
  for each row execute function app.variants_capacity_guard();

-- ── products: publish/archive, buffers, lead time, primary category ──
create function app.products_availability_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.lock_variants(old.organization_id,
                            array(select v.id from public.product_variants v where v.product_id = old.id));
  return new;
end;
$$;
create trigger products_availability_lock before update on public.products
  for each row execute function app.products_availability_lock();

-- ── serialized units ──
create function app.units_capacity_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.lock_variants(new.organization_id, array[new.variant_id]);
    return new;
  end if;
  perform app.lock_variants(old.organization_id,
                            array[old.variant_id, case when tg_op = 'UPDATE' then new.variant_id end]);
  if (tg_op = 'DELETE' or new.status <> 'active' or new.variant_id <> old.variant_id)
     and old.status = 'active' and app.unit_has_future_use(old.id) then
    raise exception 'CAPACITY_IN_USE' using errcode = 'RA011',
      detail = 'this unit is booked or held; reassign or cancel those bookings, or add a maintenance block';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger inventory_units_capacity_guard before insert or update or delete on public.inventory_units
  for each row execute function app.units_capacity_guard();

-- ── availability blocks (blackouts, maintenance, repair, staff holds…) ──
create function app.block_scope_variants(p_block public.availability_blocks)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_block.variant_id is not null then array[p_block.variant_id]
    when p_block.product_id is not null then
      array(select v.id from public.product_variants v where v.product_id = p_block.product_id)
    when p_block.inventory_unit_id is not null then
      array(select u.variant_id from public.inventory_units u where u.id = p_block.inventory_unit_id)
  end
$$;

create function app.availability_blocks_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  scopes uuid[];
begin
  -- Deleting a block only frees capacity; everything else can take it away.
  if tg_op = 'DELETE' then
    return old;
  end if;
  if num_nonnulls(new.product_id, new.variant_id, new.inventory_unit_id) = 0
     or (tg_op = 'UPDATE' and num_nonnulls(old.product_id, old.variant_id, old.inventory_unit_id) = 0) then
    perform app.lock_organization(new.organization_id, true);   -- organization-wide blackout
  else
    scopes := app.block_scope_variants(new);
    if tg_op = 'UPDATE' then
      scopes := scopes || app.block_scope_variants(old);
    end if;
    perform app.lock_variants(new.organization_id, scopes);
  end if;
  return new;
end;
$$;
create trigger availability_blocks_lock before insert or update or delete on public.availability_blocks
  for each row execute function app.availability_blocks_lock();

-- A larger partial block also takes capacity: flag on quantity changes too (M3 missed this).
drop trigger availability_blocks_flag on public.availability_blocks;
create trigger availability_blocks_flag after insert or update of period, product_id, variant_id, inventory_unit_id, quantity
  on public.availability_blocks
  for each row execute function app.flag_reservations_for_block();

-- ── organization-wide inputs to availability ──
create function app.organization_availability_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- organizations has no organization_id column; every other table does.
  org uuid := coalesce(to_jsonb(old) ->> 'organization_id', to_jsonb(old) ->> 'id')::uuid;
begin
  perform app.lock_organization(org, true);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
-- Organization deletion cascades through tables that lock their organization; skip that path.
create trigger organizations_availability_lock before update on public.organizations
  for each row execute function app.organization_availability_lock();
create trigger organization_settings_availability_lock before update on public.organization_settings
  for each row execute function app.organization_availability_lock();
create trigger categories_availability_lock before update on public.categories
  for each row execute function app.organization_availability_lock();
create trigger weather_hazard_rules_availability_lock before insert or update or delete on public.weather_hazard_rules
  for each row execute function app.organization_availability_lock();

-- ── API functions re-declared with the protocol ──

create or replace function public.reserve_inventory(
  p_organization_id uuid,
  p_items jsonb,
  p_status public.reservation_status default 'held',
  p_source public.reservation_source default 'booking_request',
  p_replaces_reservation_id uuid default null,
  p_override_lead_time boolean default false,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := app.assert_can_act(p_organization_id, 'availability.write');
  item jsonb;
  rental tstzrange;
  qty integer;
  vid uuid;
  ctx record;
  snap record;
  lock_ids uuid[];
  old public.reservations;
  rid uuid;
  hold_minutes integer;
  units uuid[];
begin
  if p_status not in ('held', 'confirmed') then
    raise exception 'INVALID_REQUEST: status must be held or confirmed' using errcode = 'RA006';
  end if;
  -- The server acting for the public may only create temporary holds (ADR 0002).
  if actor = 'system' and (p_status <> 'held' or p_override_lead_time) then
    raise exception 'INVALID_REQUEST: system context may only create holds' using errcode = 'RA006';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'INVALID_REQUEST: 1-50 items required' using errcode = 'RA006';
  end if;

  -- Validate ownership of every variant before taking any lock.
  for item in select * from jsonb_array_elements(p_items) loop
    vid := app.try_uuid(item ->> 'variant_id');
    select * into ctx from app.variant_context(vid);
    if vid is null or not found or ctx.organization_id <> p_organization_id then
      raise exception 'NOT_FOUND' using errcode = 'RA005';
    end if;
    lock_ids := lock_ids || vid;
  end loop;

  if p_replaces_reservation_id is not null then
    -- Variants of the replaced hold are read without a row lock: advisory locks come first.
    lock_ids := lock_ids || array(
      select distinct a.variant_id from public.reservation_allocations a
      where a.reservation_id = p_replaces_reservation_id and a.organization_id = p_organization_id);
  end if;

  perform app.lock_variants(p_organization_id, lock_ids);

  if p_replaces_reservation_id is not null then
    select * into old from public.reservations
    where id = p_replaces_reservation_id and organization_id = p_organization_id
    for update;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'RA005';
    end if;
    if old.status <> 'held' then
      raise exception 'INVALID_STATE: only a held reservation can be replaced' using errcode = 'RA006';
    end if;
  end if;

  perform app.release_expired_holds(lock_ids);
  if old.id is not null then
    update public.reservations set status = 'released', ended_at = now() where id = old.id;
  end if;

  select s.booking_hold_minutes into hold_minutes
  from public.organization_settings s where s.organization_id = p_organization_id;

  insert into public.reservations (organization_id, source, status, hold_expires_at, created_by, notes, confirmed_at)
  values (p_organization_id, p_source, p_status,
          case when p_status = 'held' then now() + make_interval(mins => hold_minutes) end,
          (select auth.uid()), left(p_notes, 2000),
          case when p_status = 'confirmed' then now() end)
  returning id into rid;

  for item in select * from jsonb_array_elements(p_items) loop
    vid := (item ->> 'variant_id')::uuid;
    rental := app.parse_period(item ->> 'start', item ->> 'end');
    qty := coalesce((item ->> 'quantity')::integer, 1);
    if qty < 1 or qty > 10000 then
      raise exception 'INVALID_REQUEST: quantity' using errcode = 'RA006';
    end if;

    select * into ctx from app.variant_context(vid);
    if upper(rental) - lower(rental) > make_interval(days => ctx.max_rental_days) then
      raise exception 'INVALID_REQUEST: rental longer than % days', ctx.max_rental_days using errcode = 'RA006';
    end if;
    if lower(rental) < now() + make_interval(mins => ctx.lead_time_minutes)
       and not (p_override_lead_time and actor = 'staff') then
      raise exception 'OUTSIDE_LEAD_TIME' using errcode = 'RA003';
    end if;
    if actor = 'system' and (not ctx.product_published or ctx.organization_status <> 'active') then
      raise exception 'NOT_FOUND' using errcode = 'RA005';
    end if;

    select * into snap from app.variant_availability(vid, rental);
    if cardinality(snap.reasons) > 0 then
      raise exception 'BLOCKED' using errcode = 'RA002', detail = array_to_string(snap.reasons, ',');
    end if;

    if ctx.tracking_mode = 'serialized' then
      select array_agg(id) into units from (
        select u.id
        from public.inventory_units u
        where u.variant_id = vid and u.status = 'active'
          and not exists (select 1 from public.availability_blocks b where b.inventory_unit_id = u.id and b.period && snap.occupied)
          and not exists (select 1 from public.reservation_allocations a
                          where a.inventory_unit_id = u.id and a.occupied_period && snap.occupied
                            and app.allocation_is_active(a.status, a.hold_expires_at))
        order by u.label, u.id
        limit qty
        for update skip locked
      ) free_units;
      if coalesce(cardinality(units), 0) < qty then
        raise exception 'INSUFFICIENT_AVAILABILITY' using errcode = 'RA001',
          detail = format('variant %s: requested %s, available %s', vid, qty, coalesce(cardinality(units), 0));
      end if;
      insert into public.reservation_allocations
        (organization_id, reservation_id, variant_id, inventory_unit_id, quantity, rental_period, occupied_period, status)
      select p_organization_id, rid, vid, u, 1, rental, snap.occupied, p_status
      from unnest(units) u;
    else
      if snap.available_quantity < qty then
        raise exception 'INSUFFICIENT_AVAILABILITY' using errcode = 'RA001',
          detail = format('variant %s: requested %s, available %s', vid, qty, snap.available_quantity);
      end if;
      insert into public.reservation_allocations
        (organization_id, reservation_id, variant_id, quantity, rental_period, occupied_period, status)
      values (p_organization_id, rid, vid, qty, rental, snap.occupied, p_status);
    end if;
  end loop;

  if old.id is not null then
    update public.reservations set replaced_by = rid where id = old.id;
  end if;
  return rid;
exception
  when exclusion_violation then
    -- Final guard: a concurrent writer took the unit between our check and insert.
    raise exception 'INSUFFICIENT_AVAILABILITY' using errcode = 'RA001';
end;
$$;

-- Takes the protocol locks for an existing reservation (before its row lock).
create function app.lock_reservation_variants(p_reservation_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  select r.organization_id into org from public.reservations r where r.id = p_reservation_id;
  if org is null then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.lock_variants(org, array(
    select distinct a.variant_id from public.reservation_allocations a where a.reservation_id = p_reservation_id));
  return org;
end;
$$;

-- Confirms a live hold. Expired holds cannot be confirmed: their inventory may already be gone.
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

-- Extends a live hold by the organization's hold duration, up to max_hold_renewals times.
create or replace function public.renew_hold(p_reservation_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.reservations;
  s public.organization_settings;
  expires timestamptz;
begin
  select * into r from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.assert_can_act(r.organization_id, 'availability.write');
  perform app.lock_reservation_variants(r.id);
  select * into r from public.reservations where id = p_reservation_id for update;
  if r.status <> 'held' then
    raise exception 'INVALID_STATE: reservation is %', r.status using errcode = 'RA006';
  end if;
  if r.hold_expires_at <= now() then
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  if r.hold_renewals >= s.max_hold_renewals then
    raise exception 'HOLD_RENEWAL_LIMIT' using errcode = 'RA007';
  end if;
  expires := now() + make_interval(mins => s.booking_hold_minutes);
  update public.reservations set hold_expires_at = expires, hold_renewals = hold_renewals + 1 where id = r.id;
  return expires;
end;
$$;

-- Confirming a weather block takes capacity away organization-wide: exclusive lock.
create or replace function public.confirm_weather_block(p_weather_block_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  w public.weather_blocks;
  flagged integer;
begin
  select * into w from public.weather_blocks where id = p_weather_block_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  -- Weather blocks are a staff decision (ADR 0010): never confirmed by the system context.
  if (select auth.uid()) is null or not app.has_permission(w.organization_id, 'availability.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.lock_organization(w.organization_id, true);
  select * into w from public.weather_blocks where id = p_weather_block_id for update;
  if w.status <> 'proposed' then
    raise exception 'INVALID_STATE: weather block is %', w.status using errcode = 'RA006';
  end if;
  update public.weather_blocks set status = 'confirmed', confirmed_by = (select auth.uid()), confirmed_at = now()
  where id = w.id;

  -- Flag (never cancel) overlapping active reservations of affected products.
  with inserted as (
    insert into public.reservation_flags (organization_id, reservation_id, kind, weather_block_id, message)
    select distinct a.organization_id, a.reservation_id, 'weather_block'::public.reservation_flag_kind, w.id,
           'Confirmed ' || replace(w.hazard::text, '_', ' ') || ' block: ' || w.reason
    from public.reservation_allocations a
    join public.product_variants v on v.id = a.variant_id
    where a.organization_id = w.organization_id
      and a.rental_period && w.period
      and app.allocation_is_active(a.status, a.hold_expires_at)
      and w.id in (select app.blocking_weather(v.product_id, a.rental_period))
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into flagged from inserted;
  return flagged;
end;
$$;

revoke execute on function
  app.lock_organization(uuid, boolean),
  app.lock_variants(uuid, uuid[]),
  app.future_peak_usage(uuid, boolean),
  app.unit_has_future_use(uuid),
  app.block_scope_variants(public.availability_blocks),
  app.lock_reservation_variants(uuid),
  app.variants_capacity_guard(),
  app.products_availability_lock(),
  app.units_capacity_guard(),
  app.availability_blocks_lock(),
  app.organization_availability_lock()
from public;

-- ═════════════════════════════ H2: pricing trust boundary ═════════════════════════════
-- Calculations are produced by the deterministic engine on the server from inputs the server
-- assembled from the database. Only that server code (service role) may persist them; the acting
-- staff member is recorded from the verified session, never from input.
drop function public.record_pricing_calculation(uuid, text, jsonb, jsonb, text);

create function public.record_pricing_calculation(
  p_organization_id uuid, p_engine_version text, p_input jsonb, p_output jsonb, p_input_hash text,
  p_created_by_type public.audit_actor_type, p_created_by uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  org_currency text;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  select o.currency into org_currency from public.organizations o where o.id = p_organization_id;
  if org_currency is null then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if pg_column_size(p_input) + pg_column_size(p_output) > 262144 then
    raise exception 'INVALID_REQUEST: calculation too large' using errcode = 'RA006';
  end if;
  -- Internal consistency (defence in depth; the values themselves come from the engine).
  if p_output ->> 'engineVersion' is distinct from p_engine_version
     or p_output ->> 'currency' is distinct from org_currency
     or p_input ->> 'currency' is distinct from org_currency
     or (p_output #>> '{summary,total}')::bigint is distinct from
        (p_output #>> '{summary,subtotal}')::bigint + (p_output #>> '{summary,tax}')::bigint
     or p_input_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST: inconsistent calculation' using errcode = 'RA006';
  end if;
  if (p_created_by_type = 'user') <> (p_created_by is not null) or (p_created_by is not null and not exists (
      select 1 from public.organization_members m
      where m.organization_id = p_organization_id and m.user_id = p_created_by and m.status = 'active')) then
    raise exception 'INVALID_REQUEST: actor' using errcode = 'RA006';
  end if;
  insert into public.pricing_calculations (organization_id, engine_version, input, output, input_hash, currency,
                                           total_cents, manual_review_required, created_by_type, created_by)
  values (p_organization_id, p_engine_version, p_input, p_output, p_input_hash,
          org_currency, (p_output #>> '{summary,total}')::bigint,
          (p_output ->> 'manualReviewRequired')::boolean, p_created_by_type, p_created_by)
  returning pricing_calculations.id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.record_pricing_calculation(uuid, text, jsonb, jsonb, text, public.audit_actor_type, uuid)
  from public, anon, authenticated;
grant execute on function public.record_pricing_calculation(uuid, text, jsonb, jsonb, text, public.audit_actor_type, uuid)
  to service_role;

-- ═════════════════════════════ H3: distance cache ═════════════════════════════
-- Cached road distances feed delivery charges: only the server's provider logic writes them.
create or replace function public.put_cached_distance(p_organization_id uuid, p_provider text, p_provider_version text,
                                                      p_route_key text, p_meters integer, p_ttl_days integer default 30)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_organization_id) then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if p_ttl_days not between 1 and 30 then
    raise exception 'INVALID_REQUEST: ttl' using errcode = 'RA006';
  end if;
  insert into public.delivery_distance_cache (organization_id, provider, provider_version, route_key, meters, expires_at)
  values (p_organization_id, p_provider, p_provider_version, p_route_key, p_meters, now() + make_interval(days => p_ttl_days))
  on conflict (organization_id, provider, provider_version, route_key)
  do update set meters = excluded.meters, fetched_at = now(), expires_at = excluded.expires_at;
end;
$$;
revoke execute on function public.put_cached_distance(uuid, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.put_cached_distance(uuid, text, text, text, integer, integer) to service_role;
-- Already revoked in M4; restated so the intent is visible next to the function.
revoke insert, update, delete on public.delivery_distance_cache from authenticated, anon;

-- ═════════════════════════════ H4: local time → instant ═════════════════════════════
-- A local wall-clock timestamp in an IANA zone may map to zero instants (spring-forward gap), one,
-- or two (fall-back overlap). Postgres' `AT TIME ZONE` silently picks one in both edge cases; this
-- function never does:
--   * nonexistent → RA012 INVALID_LOCAL_TIME
--   * ambiguous   → p_fold 'earlier' (first occurrence, daylight time) or 'later' (standard time);
--                   with p_fold null it raises RA012 so the caller must choose.
-- Mirrored by resolveLocalTime() in src/domain/availability/local-time.ts (parity-tested).
create function app.local_to_instant(p_local timestamp, p_time_zone text, p_fold text default null)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  guess timestamptz := p_local at time zone p_time_zone;
  off_before interval := ((guess - interval '1 day') at time zone p_time_zone) - ((guess - interval '1 day') at time zone 'UTC');
  off_after interval := ((guess + interval '1 day') at time zone p_time_zone) - ((guess + interval '1 day') at time zone 'UTC');
  c1 timestamptz := (p_local - off_before) at time zone 'UTC';
  c2 timestamptz := (p_local - off_after) at time zone 'UTC';
  ok1 boolean := (c1 at time zone p_time_zone) = p_local;
  ok2 boolean := (c2 at time zone p_time_zone) = p_local;
begin
  if p_fold is not null and p_fold not in ('earlier', 'later') then
    raise exception 'INVALID_REQUEST: fold' using errcode = 'RA006';
  end if;
  if not ok1 and not ok2 then
    raise exception 'INVALID_LOCAL_TIME: % does not exist in % (clocks move forward)', p_local, p_time_zone
      using errcode = 'RA012';
  end if;
  if ok1 and ok2 and c1 <> c2 then
    if p_fold is null then
      raise exception 'INVALID_LOCAL_TIME: % occurs twice in % (clocks move back); choose earlier or later', p_local, p_time_zone
        using errcode = 'RA012';
    end if;
    return case when p_fold = 'earlier' then least(c1, c2) else greatest(c1, c2) end;
  end if;
  return case when ok1 then c1 else c2 end;
end;
$$;
revoke execute on function app.local_to_instant(timestamp, text, text) from public;
