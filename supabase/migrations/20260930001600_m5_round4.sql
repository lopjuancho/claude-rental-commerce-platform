-- M5 hardening round 4 (Codex final review of 610acf0). ADR 0015 §15.
--
-- H1 The organization gate is taken BEFORE any row lock of a capacity/availability mutation.
--    A BEFORE ROW trigger runs while PostgreSQL already holds the target row, so waiting there for
--    the organization lock could invert against a transaction that holds the gate and wants that
--    row (deadlock). Now:
--    - a BEFORE STATEMENT trigger on every gated table takes the gate for each organization the
--      acting user belongs to (id order), before the statement touches any row;
--    - the row triggers only VERIFY the gate. In a context without a user (scripts, the service
--      role) they try to take it without waiting and fail fast with 55P03 (retryable) if it is
--      busy, so no session ever waits on the gate while holding a gated row.
-- M1 Renewing a visitor-tagged public hold takes the same per-(organization, visitor) lock as hold
--    creation (after the variant locks, as creation does), re-checks liveness and the other live
--    holds with the clock, and only then consumes budget and extends. Whoever renews (staff too).
-- M2 events.customer_id is booking-critical: frozen once the event has a confirmed booking,
--    releases pending holds when changed, part of the event signature, and a quote whose event
--    belongs to another customer is stale until reconciled.
--
-- Canonical lock order (complete): workflow rows (event → quotes by id → booking requests by id) →
-- organization gate (exclusive for catalog/availability edits, shared for bookings) → gated
-- catalog rows → variant advisory locks (ascending) → visitor lock (public holds) → reservation
-- and allocation rows (by id).

-- ═════════════════════════════ H1 ═════════════════════════════
create function app.require_org_gate(p_organization_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  k text;
  held_x text := coalesce(current_setting('app.locks_org_x', true), '');
begin
  if p_organization_id is null then
    raise exception 'require_org_gate: organization id is required' using errcode = 'RA006';
  end if;
  k := p_organization_id::text || ',';
  if position(k in held_x) > 0 then
    return;                                            -- taken before the row lock: the normal path
  end if;
  if position(k in coalesce(current_setting('app.locks_org_s', true), '')) > 0 then
    raise exception 'LOCK_ORDER_VIOLATION: organization lock upgrade (shared → exclusive)' using errcode = 'RA014';
  end if;
  -- We already hold this row: never wait here.
  if not pg_try_advisory_xact_lock(hashtextextended('org:' || p_organization_id::text, 0)) then
    raise exception 'ORGANIZATION_BUSY: another change to this organization is in progress; retry'
      using errcode = '55P03';
  end if;
  perform set_config('app.locks_org_x', held_x || k, true);
end;
$$;

-- Before any row of the statement is locked: the gate of every organization the user belongs to.
create function app.org_gate_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  org uuid;
begin
  if uid is null then
    return null;                        -- scripts / service role: row triggers try without waiting
  end if;
  for org in
    select m.organization_id from public.organization_members m
    where m.user_id = uid and m.status = 'active'
    order by m.organization_id
  loop
    perform app.lock_organization(org, true);
  end loop;
  return null;
end;
$$;

create or replace function app.variants_capacity_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  peak integer;
begin
  perform app.require_org_gate(old.organization_id);
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
  perform app.require_org_gate(old.organization_id);
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
  perform app.require_org_gate(case when tg_op = 'INSERT' then new.organization_id else old.organization_id end);
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
  perform app.require_org_gate(new.organization_id);
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
  perform app.require_org_gate((r ->> 'organization_id')::uuid);
  return case when tg_op = 'DELETE' then old else new end;
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
  perform app.require_org_gate(org);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger organizations_org_gate before update on public.organizations
  for each statement execute function app.org_gate_statement();
create trigger organization_settings_org_gate before update on public.organization_settings
  for each statement execute function app.org_gate_statement();
create trigger categories_org_gate before update on public.categories
  for each statement execute function app.org_gate_statement();
create trigger weather_hazard_rules_org_gate before insert or update or delete on public.weather_hazard_rules
  for each statement execute function app.org_gate_statement();
create trigger product_categories_org_gate before insert or update or delete on public.product_categories
  for each statement execute function app.org_gate_statement();
create trigger products_org_gate before update on public.products
  for each statement execute function app.org_gate_statement();
create trigger product_variants_org_gate before update on public.product_variants
  for each statement execute function app.org_gate_statement();
create trigger inventory_units_org_gate before insert or update or delete on public.inventory_units
  for each statement execute function app.org_gate_statement();
create trigger availability_blocks_org_gate before insert or update or delete on public.availability_blocks
  for each statement execute function app.org_gate_statement();

-- Weather blocks change availability once confirmed (period, scope, hazard, targets are staff-editable):
-- same gate, taken before their rows. confirm/lift_weather_block already take it first.
create trigger weather_blocks_org_gate before insert or update or delete on public.weather_blocks
  for each statement execute function app.org_gate_statement();
create trigger weather_block_targets_org_gate before insert or delete on public.weather_block_targets
  for each statement execute function app.org_gate_statement();
create trigger weather_blocks_availability_lock before insert or update or delete on public.weather_blocks
  for each row execute function app.organization_availability_lock();
create trigger weather_block_targets_availability_lock before insert or delete on public.weather_block_targets
  for each row execute function app.organization_availability_lock();

-- ═════════════════════════════ M2 ═════════════════════════════
create or replace function app.event_signature(p_event_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select md5(concat_ws('|', e.starts_at, e.ends_at, e.address_line1, e.address_line2, e.city, e.state,
                                        e.postal_code, e.customer_id))
                   from public.events e where e.id = p_event_id), '')
$$;

create or replace function app.quote_event_mismatch(q public.quotes)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select c.id is null or e.id is null or e.starts_at is null or e.ends_at is null
    or e.customer_id is distinct from q.customer_id            -- the event belongs to the quote's customer
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

create or replace function app.events_guard_booking()
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
      new.address_line1, new.address_line2, new.city, new.state, new.postal_code, new.customer_id)
     is not distinct from
     (old.event_date, old.end_date, old.start_time, old.end_time, old.time_fold, old.starts_at, old.ends_at,
      old.address_line1, old.address_line2, old.city, old.state, old.postal_code, old.customer_id) then
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
    perform app.close_pending_booking(qid, 'Event changed; the quote must be re-priced or reconciled before booking.');  -- 4
  end loop;
  return new;
end;
$$;

-- ═════════════════════════════ M1 ═════════════════════════════
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
  res public.reservations;
begin
  select * into l from app.lock_booking(p_booking_request_id);                                     -- 1–2
  actor := app.assert_can_act((l.br).organization_id, 'availability.write');
  perform app.assert_booking_current(l.q, l.br);                                                   -- after the locks
  perform app.assert_reservation_linked(l.q, l.br);                  -- before any budget or hold change
  -- A public hold is renewed under the SAME per-(organization, visitor) lock as hold creation, in
  -- the same position of the lock order (variants → visitor → reservation row), whoever renews it.
  select * into res from public.reservations where id = (l.br).reservation_id;
  if res.public_visitor_hash is not null then
    perform app.lock_reservation_variants(res.id);                                                  -- 3
    perform pg_advisory_xact_lock(hashtextextended('visitor:' || res.organization_id::text || ':' || res.public_visitor_hash, 0));
    select * into res from public.reservations where id = res.id;                                   -- after the waits
    if res.status <> 'held' or res.hold_expires_at <= clock_timestamp() then
      raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
    end if;
    select s.max_public_holds_per_visitor into max_holds from public.organization_settings s
    where s.organization_id = res.organization_id;
    select count(*) into used from public.reservations r
    where r.organization_id = res.organization_id and r.public_visitor_hash = res.public_visitor_hash
      and r.id <> res.id and r.status = 'held' and r.hold_expires_at > clock_timestamp();
    if used >= max_holds then
      raise exception 'PUBLIC_HOLD_LIMIT' using errcode = 'RA015',
        detail = format('%s other live holds (limit %s)', used, max_holds);
    end if;
  end if;
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

revoke execute on function app.require_org_gate(uuid), app.org_gate_statement() from public, anon, authenticated, service_role;
