-- M5 MEDIUM findings (Codex M5-HARDENING-REVIEW.md, reviewed commit 0040188). ADR 0015 §13.
--
-- M1 Generic replacement of a quote-managed hold (reserve_inventory(..., p_replaces_reservation_id))
--    was already closed by reservations_guard_quote_managed in 20260930001300 (RA010, atomic).
--    Tests now pin that nothing survives the rejected call and manual replacement still works.
-- M2 Every operation on a managed hold verifies the reservation's reciprocal links (organization,
--    quote, booking request) before changing anything: renewal and cancellation reject a
--    mislinked request (RA013, no budget consumed), and the automatic paths (quote revision /
--    cancellation / expiry, event edits, expiry caps) act only on holds that link back to the
--    request. The links are immutable once set (reservations_guard_quote_managed), so checking
--    them after the quote + request locks is final.
-- M3 The public hold budget is per quote revision by design (documented; no change here).

-- True when the request's reservation belongs to exactly this request, quote and organization.
create function app.reservation_is_linked(q public.quotes, br public.booking_requests)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.reservations r
    where r.id = br.reservation_id and r.organization_id = q.organization_id
      and r.booking_request_id = br.id and r.quote_id = q.id and br.quote_id = q.id)
$$;

create function app.assert_reservation_linked(q public.quotes, br public.booking_requests)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.reservation_is_linked(q, br) then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'the hold does not belong to this booking request';
  end if;
end;
$$;

-- Automatic close: ends only the holds that link back to the request (never br.reservation_id blindly).
create or replace function app.close_pending_booking(p_quote_id uuid, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  br public.booking_requests;
  rid uuid;
begin
  select * into br from public.booking_requests where quote_id = p_quote_id and status = 'pending' for update;   -- 2
  if not found then
    return;
  end if;
  for rid in
    select r.id from public.reservations r
    where r.booking_request_id = br.id and r.quote_id = p_quote_id and r.organization_id = br.organization_id
      and r.status = 'held'
    order by r.id
  loop
    perform app.end_reservation(rid, 'system');                                                     -- 3–4
  end loop;
  update public.booking_requests
  set status = 'cancelled', decided_at = now(), decided_by = (select auth.uid()), decision_note = left(p_note, 1000)
  where id = br.id;
end;
$$;

-- Automatic cap: only the holds that link back to the request.
create or replace function app.cap_pending_hold(p_quote_id uuid, p_until timestamptz)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  br public.booking_requests;
  rid uuid;
  capped timestamptz;
begin
  select * into br from public.booking_requests where quote_id = p_quote_id and status = 'pending' for update;   -- 2
  if not found or p_until is null then
    return null;
  end if;
  for rid in
    select r.id from public.reservations r
    where r.booking_request_id = br.id and r.quote_id = p_quote_id and r.organization_id = br.organization_id
      and r.status = 'held'
    order by r.id
  loop
    perform app.lock_reservation_variants(rid);                                                     -- 3
    update public.reservations set hold_expires_at = least(hold_expires_at, p_until)                -- 4
    where id = rid and status = 'held'
    returning hold_expires_at into capped;
  end loop;
  return capped;
end;
$$;

-- Pre-locking for multi-quote paths uses the same reciprocal links as the close/cap above.
create or replace function app.lock_pending_bookings(p_quote_ids uuid[])
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
    where b.quote_id = any (p_quote_ids) and b.status = 'pending'
    order by 1
  loop
    perform app.lock_variants(org, array(
      select distinct a.variant_id
      from public.booking_requests b
      join public.reservations r on r.booking_request_id = b.id and r.quote_id = b.quote_id
                                and r.organization_id = b.organization_id and r.status = 'held'
      join public.reservation_allocations a on a.reservation_id = r.id
      where b.quote_id = any (p_quote_ids) and b.status = 'pending' and b.organization_id = org));
  end loop;
end;
$$;

-- Cancellation / decline: the request's hold must link back to it (RA013 otherwise; nothing changes).
create or replace function public.close_booking_request(p_booking_request_id uuid, p_status public.booking_request_status,
                                                        p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l record;
  actor text;
begin
  select * into l from app.lock_booking(p_booking_request_id);                                     -- 1–2
  actor := app.assert_can_act((l.br).organization_id, 'availability.write');
  if p_status not in ('declined', 'cancelled') or (p_status = 'declined' and actor <> 'staff') then
    raise exception 'INVALID_REQUEST: status' using errcode = 'RA006';
  end if;
  if (l.br).status <> 'pending' then
    raise exception 'INVALID_STATE: booking request is %', (l.br).status using errcode = 'RA010';
  end if;
  if (l.br).reservation_id is not null then
    perform app.assert_reservation_linked(l.q, l.br);
    perform app.end_reservation((l.br).reservation_id, actor);                                      -- 3–4
  end if;
  update public.booking_requests
  set status = p_status, decided_by = (select auth.uid()), decided_at = now(), decision_note = left(p_note, 1000)
  where id = (l.br).id;
end;
$$;

-- Renewal: links verified before the budget is touched.
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
  perform app.assert_reservation_linked(l.q, l.br);                  -- before any budget or hold change
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

-- Request: never reuses (or returns) a hold that does not link back to the request.
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
    select a.variant_id from public.reservation_allocations a
    join public.reservations r on r.id = a.reservation_id
    where r.booking_request_id = br.id and r.status = 'held'));

  if br.id is not null and (not app.reservation_is_linked(q, br)
                            or br.quote_revision is distinct from q.revision
                            or br.pricing_calculation_id is distinct from q.pricing_calculation_id
                            or br.event_signature is distinct from app.event_signature(q.event_id)
                            or br.items_signature is distinct from app.quote_items_signature(q.id)) then
    -- Stale or mislinked (should already have been closed by the triggers): close it — releasing
    -- only holds linked back to it — and start fresh.
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

revoke execute on function
  app.reservation_is_linked(public.quotes, public.booking_requests),
  app.assert_reservation_linked(public.quotes, public.booking_requests)
from public, anon, authenticated, service_role;
