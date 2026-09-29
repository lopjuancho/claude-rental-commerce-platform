-- M5 workflow boundaries, round 3 (Codex review of 0040188). ADR 0015 §12.
--
-- H1 A confirmed booking is frozen: the accepted quote's snapshot / customer / event links, its
--    event's date, times and address, and its confirmed reservation cannot be changed (RA010).
--    Amendments will be a separate, explicit workflow.
-- H2 Event validity is judged against the IMMUTABLE pricing snapshot (item periods and the priced
--    delivery destination in pricing_calculations.input), never against quotes.price_request.
-- H3 A hold never outlives its quote (capped at quotes.expires_at, also when the expiry moves), and
--    every expiry decision is taken with clock_timestamp() AFTER the locks are held (now() is the
--    transaction start and would be stale after a lock wait).
-- H4 One canonical order for inventory locks, enforced: per organization, variant advisory locks
--    are taken in ascending uuid order across the WHOLE transaction. Acquiring a lower variant after
--    a higher one, or upgrading a shared organization lock to exclusive, raises LOCK_ORDER_VIOLATION
--    (RA014) instead of risking a deadlock. Operations spanning several quotes lock all quotes, then
--    all booking requests, then the union of their variants, before changing anything. Catalog and
--    block edits (which can touch many rows in one statement) take the organization lock exclusively.
--
-- Lock order (complete): 0. event row → 1. quotes (by id) → 2. booking requests (by id) →
-- 3. organization advisory lock, then variant advisory locks (ascending uuid) → 4. reservation rows (by id).

-- ═════════════════════════════ H4: lock primitives ═════════════════════════════
-- Transaction-local bookkeeping (set_config(..., true) is reset at commit/rollback and reverted
-- with a rolled-back subtransaction, exactly like the advisory locks themselves).
create or replace function app.lock_organization(p_organization_id uuid, p_exclusive boolean)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  k text;
  held_x text := coalesce(current_setting('app.locks_org_x', true), '');
  held_s text := coalesce(current_setting('app.locks_org_s', true), '');
begin
  -- A NULL key would make pg_advisory_xact_lock a silent no-op (strict function).
  if p_organization_id is null then
    raise exception 'lock_organization: organization id is required' using errcode = 'RA006';
  end if;
  k := p_organization_id::text || ',';
  if position(k in held_x) > 0 then
    return;                                             -- exclusive already covers everything
  end if;
  if p_exclusive then
    if position(k in held_s) > 0 then
      raise exception 'LOCK_ORDER_VIOLATION: organization lock upgrade (shared → exclusive)' using errcode = 'RA014';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('org:' || p_organization_id::text, 0));
    perform set_config('app.locks_org_x', held_x || k, true);
  elsif position(k in held_s) = 0 then
    perform pg_advisory_xact_lock_shared(hashtextextended('org:' || p_organization_id::text, 0));
    perform set_config('app.locks_org_s', held_s || k, true);
  end if;
end;
$$;

create or replace function app.lock_variants(p_organization_id uuid, p_variant_ids uuid[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  vid uuid;
  slot text := 'app.lv_' || replace(p_organization_id::text, '-', '');
  held text;
  top uuid;
begin
  perform app.lock_organization(p_organization_id, false);
  if position(p_organization_id::text || ',' in coalesce(current_setting('app.locks_org_x', true), '')) > 0 then
    -- The organization is exclusively ours: nobody else can hold or wait for its variant locks.
    for vid in select distinct x from unnest(p_variant_ids) x where x is not null order by x loop
      perform pg_advisory_xact_lock(hashtextextended('variant:' || vid::text, 0));
    end loop;
    return;
  end if;
  held := coalesce(current_setting(slot || '_held', true), '');
  top := nullif(current_setting(slot || '_top', true), '')::uuid;
  for vid in select distinct x from unnest(p_variant_ids) x where x is not null order by x loop
    continue when position(vid::text in held) > 0;     -- re-entrant: already ours
    if top is not null and vid < top then
      raise exception 'LOCK_ORDER_VIOLATION: variant % requested after %', vid, top using errcode = 'RA014';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('variant:' || vid::text, 0));
    held := held || vid::text || ',';
    top := vid;
  end loop;
  perform set_config(slot || '_held', held, true);
  perform set_config(slot || '_top', coalesce(top::text, ''), true);
end;
$$;

-- Catalog and block edits can touch many rows in one statement (row triggers fire in planner order),
-- so they serialize on the organization instead of on individual variants.
create or replace function app.variants_capacity_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  peak integer;
begin
  perform app.lock_organization(old.organization_id, true);
  if new.tracking_mode is distinct from old.tracking_mode and (
       (old.tracking_mode = 'pooled' and app.future_peak_usage(old.id) > 0)
       or (old.tracking_mode = 'serialized' and exists (
             select 1 from public.inventory_units u where u.variant_id = old.id and app.unit_has_future_use(u.id)))) then
    raise exception 'CAPACITY_IN_USE: tracking mode cannot change while bookings or holds exist'
      using errcode = 'RA011';
  end if;
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

create or replace function app.products_availability_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.lock_organization(old.organization_id, true);
  return new;
end;
$$;

create or replace function app.units_capacity_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.lock_organization(case when tg_op = 'INSERT' then new.organization_id else old.organization_id end, true);
  if tg_op = 'INSERT' then
    return new;
  end if;
  if (tg_op = 'DELETE' or new.status <> 'active' or new.variant_id <> old.variant_id)
     and old.status = 'active' and app.unit_has_future_use(old.id) then
    raise exception 'CAPACITY_IN_USE' using errcode = 'RA011',
      detail = 'this unit is booked or held; reassign or cancel those bookings, or add a maintenance block';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function app.availability_blocks_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Deleting a block only frees capacity; everything else can take it away.
  if tg_op = 'DELETE' then
    return old;
  end if;
  perform app.lock_organization(new.organization_id, true);
  return new;
end;
$$;

create or replace function app.product_categories_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  perform app.lock_organization((r ->> 'organization_id')::uuid, true);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Bulk hold release: reservation rows in id order; a row another transaction holds is left for
-- the next pass (an expired hold already counts as free in every availability check).
create or replace function app.release_expired_holds(p_variant_ids uuid[])
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update public.reservations r
    set status = 'released', ended_at = now()
    where r.id in (
      select x.id from public.reservations x
      where x.status = 'held' and x.hold_expires_at <= now()
        and exists (select 1 from public.reservation_allocations a where a.reservation_id = x.id and a.variant_id = any (p_variant_ids))
      order by x.id
      for update skip locked)
    returning 1
  )
  select count(*)::integer from expired
$$;

create or replace function public.sweep_expired_holds()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update public.reservations r
    set status = 'released', ended_at = now()
    where r.id in (
      select x.id from public.reservations x
      where x.status = 'held' and x.hold_expires_at <= clock_timestamp()
      order by x.id
      for update skip locked)
    returning 1
  )
  select count(*)::integer from expired
$$;

-- Steps 2–3 for several quotes whose rows the caller already holds (step 1): their pending booking
-- requests (by id), then the union of their holds' variants per organization, in one ordered call.
create function app.lock_pending_bookings(p_quote_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  perform 1 from public.booking_requests b
  where b.quote_id = any (p_quote_ids) and b.status = 'pending'
  order by b.id
  for update;
  for org in
    select distinct b.organization_id from public.booking_requests b
    where b.quote_id = any (p_quote_ids) and b.status = 'pending' and b.reservation_id is not null
    order by 1
  loop
    perform app.lock_variants(org, array(
      select distinct a.variant_id
      from public.booking_requests b
      join public.reservation_allocations a on a.reservation_id = b.reservation_id
      where b.quote_id = any (p_quote_ids) and b.status = 'pending' and b.organization_id = org));
  end loop;
end;
$$;

-- Quote expiry in canonical order; quotes a live transaction holds are expired on the next pass.
create or replace function public.expire_quotes()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  ids uuid[];
begin
  select coalesce(array_agg(x.id order by x.id), '{}') into ids
  from (select q.id from public.quotes q
        where q.status in ('sent', 'viewed') and q.expires_at <= clock_timestamp()
        order by q.id
        for update skip locked) x;                                                                 -- 1
  if cardinality(ids) = 0 then
    return 0;
  end if;
  perform app.lock_pending_bookings(ids);                                                          -- 2–3
  update public.quotes set status = 'expired' where id = any (ids);   -- trigger releases holds (4)
  return cardinality(ids);
end;
$$;

-- ═════════════════════════════ H2: the snapshot is the authority ═════════════════════════════
-- True when the quote's IMMUTABLE pricing snapshot does not describe its event: every priced item
-- must cover exactly the event's window, and a priced delivery must have been priced for exactly
-- the event's address. quotes.price_request (mutable) plays no part.
create or replace function app.quote_event_mismatch(q public.quotes)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select c.id is null or e.id is null or e.starts_at is null or e.ends_at is null
    or jsonb_typeof(c.input -> 'items') is distinct from 'array'
    or jsonb_array_length(c.input -> 'items') = 0
    or exists (select 1 from jsonb_array_elements(c.input -> 'items') it
               where (it ->> 'start')::timestamptz is distinct from e.starts_at
                  or (it ->> 'end')::timestamptz is distinct from e.ends_at)
    or (coalesce(c.input #>> '{delivery,status}', 'not_requested') <> 'not_requested' and (
          jsonb_typeof(c.input -> 'destination') is distinct from 'object'
       or coalesce(c.input #>> '{destination,line1}', '') <> coalesce(e.address_line1, '')
       or coalesce(c.input #>> '{destination,line2}', '') <> coalesce(e.address_line2, '')
       or coalesce(c.input #>> '{destination,city}', '') <> coalesce(e.city, '')
       or coalesce(c.input #>> '{destination,state}', '') <> coalesce(e.state, '')
       or coalesce(c.input #>> '{destination,postalCode}', '') <> coalesce(e.postal_code, '')))
  from (select 1) one
  left join public.pricing_calculations c on c.id = q.pricing_calculation_id and c.organization_id = q.organization_id
  left join public.events e on e.id = q.event_id and e.organization_id = q.organization_id
$$;

-- ═════════════════════════════ H1: confirmed bookings are frozen ═════════════════════════════
-- Event edits (lock order 0 → 1…4): lock every quote on the event, refuse if any booking on it is
-- confirmed, otherwise release the pending holds of its open quotes (they are stale now).
drop trigger events_release_holds on public.events;
drop function app.events_release_holds();

create function app.events_guard_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  qids uuid[];
  open_ids uuid[];
  qid uuid;
begin
  if tg_op = 'UPDATE' and
     (new.event_date, new.end_date, new.start_time, new.end_time, new.time_fold, new.starts_at, new.ends_at,
      new.address_line1, new.address_line2, new.city, new.state, new.postal_code)
     is not distinct from
     (old.event_date, old.end_date, old.start_time, old.end_time, old.time_fold, old.starts_at, old.ends_at,
      old.address_line1, old.address_line2, old.city, old.state, old.postal_code) then
    return new;                                          -- notes, guest counts…: not booking-critical
  end if;
  select coalesce(array_agg(x.id order by x.id), '{}') into qids
  from (select q.id from public.quotes q where q.event_id = old.id order by q.id for update) x;      -- 1
  -- Decided after the quote locks: a confirmation that committed while we waited is seen here.
  if exists (select 1 from public.quotes q where q.id = any (qids) and q.status = 'accepted')
     or exists (select 1 from public.booking_requests b where b.event_id = old.id and b.status = 'confirmed')
     or exists (select 1 from public.reservations r where r.event_id = old.id and r.status in ('confirmed', 'completed')) then
    raise exception 'INVALID_STATE: this event belongs to a confirmed booking; changes need an amendment'
      using errcode = 'RA010';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  select coalesce(array_agg(q.id order by q.id), '{}') into open_ids
  from public.quotes q where q.id = any (qids) and q.status in ('draft', 'sent', 'viewed');
  perform app.lock_pending_bookings(open_ids);                                                     -- 2–3
  foreach qid in array open_ids loop
    perform app.close_pending_booking(qid, 'Event changed; the quote must be re-priced before booking.');  -- 4
  end loop;
  return new;
end;
$$;
-- After events_derive_period (alphabetical), so starts_at / ends_at are already recomputed.
create trigger events_guard_booking before update or delete on public.events
  for each row execute function app.events_guard_booking();

create or replace function app.quotes_require_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An accepted quote describes a confirmed booking: its links and snapshot are frozen.
  if old.status = 'accepted' and
     (new.event_id, new.customer_id, new.pricing_calculation_id, new.price_request)
     is distinct from (old.event_id, old.customer_id, old.pricing_calculation_id, old.price_request) then
    raise exception 'INVALID_STATE: an accepted quote is a confirmed booking; changes need an amendment'
      using errcode = 'RA010';
  end if;
  if new.status = 'accepted' and old.status <> 'accepted' and not (
    new.pricing_calculation_id is not distinct from old.pricing_calculation_id
    and new.price_request is not distinct from old.price_request
    and new.event_id is not distinct from old.event_id
    and new.customer_id is not distinct from old.customer_id
    and exists (
      select 1 from public.booking_requests b
      join public.reservations r on r.id = b.reservation_id
      where b.quote_id = new.id and b.status = 'confirmed' and b.quote_revision = old.revision
        and b.pricing_calculation_id = old.pricing_calculation_id
        and r.status = 'confirmed' and r.booking_request_id = b.id and r.quote_id = new.id)
  ) then
    raise exception 'INVALID_STATE: a quote is accepted only by confirming its booking request'
      using errcode = 'RA010';
  end if;
  return new;
end;
$$;

-- Reservations that belong to a quote are changed only by the booking workflow: never re-linked or
-- replaced, and a confirmed one is never ended outside an (explicit, future) amendment workflow.
create function app.reservations_guard_quote_managed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.booking_request_id is null and old.quote_id is null then
    return new;
  end if;
  if (new.booking_request_id, new.quote_id, new.event_id, new.organization_id)
     is distinct from (old.booking_request_id, old.quote_id, old.event_id, old.organization_id)
     or new.replaced_by is distinct from old.replaced_by then
    raise exception 'INVALID_STATE: this hold belongs to a booking request; use the booking request actions'
      using errcode = 'RA010';
  end if;
  if old.status = 'confirmed' and new.status not in ('confirmed', 'completed') then
    raise exception 'INVALID_STATE: a confirmed booking is changed only through an amendment'
      using errcode = 'RA010';
  end if;
  return new;
end;
$$;
create trigger reservations_guard_quote_managed before update on public.reservations
  for each row execute function app.reservations_guard_quote_managed();

-- ═════════════════════════════ H3: expiry after the locks ═════════════════════════════
create or replace function app.confirm_held_reservation(p_reservation_id uuid, p_ignore_weather boolean, p_actor text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.reservations;
  why text[];
begin
  perform app.lock_reservation_variants(p_reservation_id);
  select * into r from public.reservations where id = p_reservation_id for update;
  if r.status <> 'held' then
    raise exception 'INVALID_STATE: reservation is %', r.status using errcode = 'RA006';
  end if;
  if r.hold_expires_at <= clock_timestamp() then                      -- after the waits, not before
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  why := app.hold_invalid_reasons(r.id, p_actor);
  if why = array['INSUFFICIENT_QUANTITY'] then
    raise exception 'INSUFFICIENT_AVAILABILITY' using errcode = 'RA001', detail = 'INSUFFICIENT_QUANTITY';
  elsif cardinality(why) > 0 then
    raise exception 'BLOCKED' using errcode = 'RA002', detail = array_to_string(why, ',');
  end if;
  if not (p_ignore_weather and p_actor = 'staff') and exists (
    select 1 from public.reservation_allocations a
    join public.product_variants v on v.id = a.variant_id
    where a.reservation_id = r.id and exists (select 1 from app.blocking_weather(v.product_id, a.rental_period))
  ) then
    raise exception 'BLOCKED' using errcode = 'RA002', detail = 'WEATHER_BLOCK';
  end if;
  update public.reservations set status = 'confirmed', hold_expires_at = null, confirmed_at = now() where id = r.id;
end;
$$;

create or replace function app.extend_held_reservation(p_reservation_id uuid, p_enforce_hold_limit boolean)
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
  perform app.lock_reservation_variants(p_reservation_id);
  select * into r from public.reservations where id = p_reservation_id for update;
  if r.status <> 'held' then
    raise exception 'INVALID_STATE: reservation is %', r.status using errcode = 'RA006';
  end if;
  if r.hold_expires_at <= clock_timestamp() then
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  if p_enforce_hold_limit and r.hold_renewals >= s.max_hold_renewals then
    raise exception 'HOLD_RENEWAL_LIMIT' using errcode = 'RA007';
  end if;
  expires := clock_timestamp() + make_interval(mins => s.booking_hold_minutes);
  update public.reservations set hold_expires_at = expires, hold_renewals = hold_renewals + 1 where id = r.id;
  return expires;
end;
$$;

-- Caps the pending hold of a quote at p_until (the quote's expiry). Caller holds the quote row.
create function app.cap_pending_hold(p_quote_id uuid, p_until timestamptz)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  br public.booking_requests;
  capped timestamptz;
begin
  select * into br from public.booking_requests where quote_id = p_quote_id and status = 'pending' for update;   -- 2
  if br.reservation_id is null or p_until is null then
    return null;
  end if;
  perform app.lock_reservation_variants(br.reservation_id);                                         -- 3
  update public.reservations set hold_expires_at = least(hold_expires_at, p_until)                  -- 4
  where id = br.reservation_id and status = 'held'
  returning hold_expires_at into capped;
  return capped;
end;
$$;

-- Quote row triggers fire once per row, in planner order, when a statement updates several quotes.
-- If this transaction has not locked the organization yet (no ordered pre-locking happened), the
-- first hold change takes it exclusively, so the per-row variant locks that follow cannot be taken
-- in conflicting orders. Ordered callers (expire_quotes, event edits, the booking functions) have
-- already locked it shared plus every variant they touch, so nothing new is acquired here.
create function app.lock_org_for_row_trigger(p_organization_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  k text := p_organization_id::text || ',';
begin
  if position(k in coalesce(current_setting('app.locks_org_x', true), '')) = 0
     and position(k in coalesce(current_setting('app.locks_org_s', true), '')) = 0 then
    perform app.lock_organization(p_organization_id, true);
  end if;
end;
$$;

create or replace function app.quotes_release_holds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.revision <> old.revision
      or (new.status in ('cancelled', 'declined', 'expired') and new.status <> old.status)
      or (new.expires_at is distinct from old.expires_at and new.expires_at is not null))
     and exists (select 1 from public.booking_requests b where b.quote_id = new.id and b.status = 'pending') then
    perform app.lock_org_for_row_trigger(new.organization_id);
  end if;
  if new.revision <> old.revision then
    perform app.close_pending_booking(new.id, format('Quote revised (revision %s); request the booking again.', new.revision));
  elsif new.status in ('cancelled', 'declined', 'expired') and new.status <> old.status then
    perform app.close_pending_booking(new.id, format('Quote %s.', new.status));
  elsif new.expires_at is distinct from old.expires_at and new.expires_at is not null then
    perform app.cap_pending_hold(new.id, new.expires_at);         -- a hold never outlives its quote
  end if;
  return null;
end;
$$;

create or replace function app.assert_booking_current(q public.quotes, br public.booking_requests)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if br.status <> 'pending' then
    raise exception 'INVALID_STATE: booking request is %', br.status using errcode = 'RA010';
  end if;
  if q.status not in ('draft', 'sent', 'viewed') then
    raise exception 'INVALID_STATE: quote is %', q.status using errcode = 'RA010';
  end if;
  if q.expires_at is not null and q.expires_at <= clock_timestamp() then   -- decided after the locks
    raise exception 'QUOTE_EXPIRED' using errcode = 'RA009';
  end if;
  if br.quote_revision is distinct from q.revision
     or br.pricing_calculation_id is distinct from q.pricing_calculation_id
     or br.customer_id is distinct from q.customer_id
     or br.event_id is distinct from q.event_id then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'quote revision or pricing snapshot changed';
  end if;
  if app.quote_event_mismatch(q) or br.event_signature is distinct from app.event_signature(q.event_id) then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'event changed after pricing or the hold';
  end if;
  if br.items_signature is distinct from app.quote_items_signature(q.id) then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'held items differ from the quote';
  end if;
end;
$$;

create or replace function public.request_booking(p_quote_id uuid, p_source text default 'web', p_message text default null)
returns table (booking_request_id uuid, reservation_id uuid, hold_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  q public.quotes;
  actor text;
  br public.booking_requests;
  res public.reservations;
  items jsonb;
  rid uuid;
  max_holds integer;
  used integer;
begin
  -- 1. quote (every decision below is taken after this lock, with clock_timestamp())
  select * into q from public.quotes where id = p_quote_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  actor := app.assert_can_act(q.organization_id, 'availability.write');
  if actor = 'staff' and not app.has_permission(q.organization_id, 'quotes.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if p_source not in ('web', 'assistant', 'admin') or (actor = 'system' and p_source = 'admin') then
    raise exception 'INVALID_REQUEST: source' using errcode = 'RA006';
  end if;
  if q.pricing_calculation_id is null or q.status not in ('draft', 'sent', 'viewed') then
    raise exception 'INVALID_STATE: quote is %', q.status using errcode = 'RA010';
  end if;
  if q.expires_at is not null and q.expires_at <= clock_timestamp() then
    raise exception 'QUOTE_EXPIRED' using errcode = 'RA009';
  end if;
  if app.quote_event_mismatch(q) then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'event changed since the quote was priced';
  end if;

  -- 2. booking request
  select * into br from public.booking_requests b where b.quote_id = q.id and b.status = 'pending' for update;

  -- 3. every variant this call may touch (the old hold's and the quote's), in one ordered call
  perform app.lock_variants(q.organization_id, array(
    select i.variant_id from public.quote_items i where i.quote_id = q.id
    union
    select a.variant_id from public.reservation_allocations a where a.reservation_id = br.reservation_id));

  if br.id is not null and (br.quote_revision is distinct from q.revision
                            or br.pricing_calculation_id is distinct from q.pricing_calculation_id
                            or br.event_signature is distinct from app.event_signature(q.event_id)
                            or br.items_signature is distinct from app.quote_items_signature(q.id)) then
    -- Stale (should already have been closed by the revision/event triggers): close it, start fresh.
    perform app.close_pending_booking(q.id, 'Stale booking request replaced.');
    br := null;
  end if;
  if br.id is not null then
    select * into res from public.reservations r where r.id = br.reservation_id;
    if res.status = 'held' and res.hold_expires_at > clock_timestamp() then
      return query select br.id, res.id, res.hold_expires_at;   -- idempotent: the live hold
      return;
    end if;
  end if;

  -- The attempt's hold budget (public/assistant only; staff are trusted to hold for customers).
  if actor <> 'staff' then
    select 1 + s.max_hold_renewals into max_holds from public.organization_settings s where s.organization_id = q.organization_id;
    insert into public.quote_hold_budgets as b (organization_id, quote_id, revision, used)
    values (q.organization_id, q.id, q.revision, 0)
    on conflict (quote_id, revision) do nothing;
    select b.used into used from public.quote_hold_budgets b where b.quote_id = q.id and b.revision = q.revision;
    if used >= max_holds then
      raise exception 'HOLD_RENEWAL_LIMIT' using errcode = 'RA007';
    end if;
    update public.quote_hold_budgets b set used = b.used + 1 where b.quote_id = q.id and b.revision = q.revision;
  end if;

  -- 3 (re-entrant) + 4. availability and the new hold
  select jsonb_agg(jsonb_build_object('variant_id', i.variant_id, 'quantity', i.quantity,
                                      'start', lower(i.rental_period), 'end', upper(i.rental_period))
                   order by i.sort_order)
  into items from public.quote_items i where i.quote_id = q.id;
  rid := public.reserve_inventory(q.organization_id, items, 'held', 'booking_request', null, false,
                                  'Booking request for quote ' || q.quote_number);

  if br.id is null then
    insert into public.booking_requests (organization_id, quote_id, customer_id, event_id, source, reservation_id,
                                         customer_message, created_by_type, created_by, quote_revision,
                                         pricing_calculation_id, items_signature, event_signature)
    values (q.organization_id, q.id, q.customer_id, q.event_id, p_source, rid, left(p_message, 2000),
            case when actor = 'staff' then 'user' when p_source = 'assistant' then 'ai' else 'public' end::public.audit_actor_type,
            (select auth.uid()), q.revision, q.pricing_calculation_id, app.quote_items_signature(q.id),
            app.event_signature(q.event_id))
    returning * into br;
  else
    update public.booking_requests
    set reservation_id = rid, quote_revision = q.revision, pricing_calculation_id = q.pricing_calculation_id,
        items_signature = app.quote_items_signature(q.id), event_signature = app.event_signature(q.event_id)
    where id = br.id returning * into br;
  end if;
  -- A hold never outlives its quote.
  update public.reservations r
  set quote_id = q.id, event_id = q.event_id, booking_request_id = br.id,
      hold_expires_at = least(r.hold_expires_at, q.expires_at)
  where r.id = rid
  returning * into res;
  return query select br.id, res.id, res.hold_expires_at;
end;
$$;

create or replace function public.renew_booking_hold(p_booking_request_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l record;
  actor text;
  max_holds integer;
  used integer;
  expires timestamptz;
begin
  select * into l from app.lock_booking(p_booking_request_id);                                     -- 1–2
  actor := app.assert_can_act((l.br).organization_id, 'availability.write');
  perform app.assert_booking_current(l.q, l.br);                                                   -- after the locks
  if actor <> 'staff' then
    select 1 + s.max_hold_renewals into max_holds from public.organization_settings s where s.organization_id = (l.q).organization_id;
    insert into public.quote_hold_budgets as b (organization_id, quote_id, revision, used)
    values ((l.q).organization_id, (l.q).id, (l.q).revision, 0)
    on conflict (quote_id, revision) do nothing;
    select b.used into used from public.quote_hold_budgets b where b.quote_id = (l.q).id and b.revision = (l.q).revision;
    if used >= max_holds then
      raise exception 'HOLD_RENEWAL_LIMIT' using errcode = 'RA007';
    end if;
    update public.quote_hold_budgets b set used = b.used + 1 where b.quote_id = (l.q).id and b.revision = (l.q).revision;
  end if;
  expires := app.extend_held_reservation((l.br).reservation_id, true);                              -- 3–4
  if (l.q).expires_at is not null and (l.q).expires_at < expires then
    update public.reservations set hold_expires_at = (l.q).expires_at where id = (l.br).reservation_id;
    expires := (l.q).expires_at;
  end if;
  return expires;
end;
$$;

create or replace function public.confirm_booking_request(p_booking_request_id uuid, p_ignore_weather boolean default false)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l record;
  q public.quotes;
  br public.booking_requests;
  res public.reservations;
begin
  select * into l from app.lock_booking(p_booking_request_id);                                     -- 1–2
  q := l.q;
  br := l.br;
  if app.assert_can_act(br.organization_id, 'quotes.write') <> 'staff'
     or not app.has_permission(br.organization_id, 'availability.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  -- quote status + expiry (clock), revision, snapshot, links, event (vs snapshot), items
  perform app.assert_booking_current(q, br);
  if q.manual_review_required and q.review_approved_at is null then
    raise exception 'REVIEW_REQUIRED' using errcode = 'RA008';
  end if;
  select * into res from public.reservations where id = br.reservation_id;                        -- read only
  if res.id is null or res.booking_request_id is distinct from br.id or res.quote_id is distinct from q.id
     or res.organization_id <> q.organization_id
     or br.items_signature is distinct from app.reservation_signature(res.id) then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'the hold does not belong to this booking request';
  end if;
  if res.status <> 'held' or res.hold_expires_at <= clock_timestamp() then
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  -- 3–4: variant locks, reservation row, hold still live (re-checked), availability, weather.
  perform app.confirm_held_reservation(res.id, p_ignore_weather, 'staff');

  update public.booking_requests set status = 'confirmed', decided_by = (select auth.uid()), decided_at = now()
  where id = br.id;
  update public.quotes set status = 'accepted' where id = q.id;
  return res.id;
end;
$$;

revoke execute on function
  app.lock_org_for_row_trigger(uuid),
  app.lock_pending_bookings(uuid[]),
  app.cap_pending_hold(uuid, timestamptz)
from public, anon, authenticated, service_role;
