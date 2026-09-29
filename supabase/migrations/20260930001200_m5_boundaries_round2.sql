-- M5 workflow boundaries, round 2 (re-verification of ADR 0015 §10). ADR 0015 §11.
--
-- 1  A quote's priced items are bound to its event: editing the event (times or address) makes the
--    quote stale (no hold, renewal or confirmation until it is re-priced) and releases a pending hold.
-- 2  Confirming the booking request is the ONLY way a quote becomes 'accepted' (a direct status
--    update would skip the hold, snapshot and availability checks).
-- 3  Renewal re-verifies the whole attempt (quote status + expiry, revision, snapshot, event, items),
--    so a quote that expired by time can no longer keep a hold alive.
-- 7  Confirmation also verifies the booking request ↔ quote ↔ reservation links.
--
-- CANONICAL LOCK ORDER (extends 20260930001100): 0. event row (an UPDATE of the event) →
-- 1. quote → 2. booking_request → 3. org/variant advisory locks → 4. reservation rows.
-- No function holding a quote lock ever locks an event row (they only read it).

-- ───────────────────────────── quote ↔ event binding ─────────────────────────────
-- True when the quote's priced items / delivery address no longer describe its event.
create function app.quote_event_mismatch(q public.quotes)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select e.id is null or e.starts_at is null or e.ends_at is null
    or exists (select 1 from public.quote_items i
               where i.quote_id = q.id and i.rental_period <> tstzrange(e.starts_at, e.ends_at, '[)'))
    or (jsonb_typeof(q.price_request -> 'eventAddress') = 'object' and (
          coalesce(q.price_request #>> '{eventAddress,line1}', '') <> coalesce(e.address_line1, '')
       or coalesce(q.price_request #>> '{eventAddress,line2}', '') <> coalesce(e.address_line2, '')
       or coalesce(q.price_request #>> '{eventAddress,city}', '') <> coalesce(e.city, '')
       or coalesce(q.price_request #>> '{eventAddress,state}', '') <> coalesce(e.state, '')
       or coalesce(q.price_request #>> '{eventAddress,postalCode}', '') <> coalesce(e.postal_code, '')))
  from (select 1) one
  left join public.events e on e.id = q.event_id
$$;

-- Editing an event releases the pending holds of the open quotes priced for it (lock order 0 → 1…4).
create function app.events_release_holds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  qid uuid;
begin
  if (new.starts_at, new.ends_at, new.address_line1, new.address_line2, new.city, new.state, new.postal_code)
     is not distinct from
     (old.starts_at, old.ends_at, old.address_line1, old.address_line2, old.city, old.state, old.postal_code) then
    return null;
  end if;
  for qid in
    select q.id from public.quotes q
    where q.event_id = new.id and q.status in ('draft', 'sent', 'viewed')
    order by q.id
    for update
  loop
    perform app.close_pending_booking(qid, 'Event changed; the quote must be re-priced before booking.');
  end loop;
  return null;
end;
$$;
create trigger events_release_holds after update on public.events
  for each row execute function app.events_release_holds();

-- ───────────────────────────── one way to 'accepted' ─────────────────────────────
-- Runs after quotes_guard and before quotes_revision (alphabetical).
create function app.quotes_require_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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
create trigger quotes_require_booking before update on public.quotes
  for each row execute function app.quotes_require_booking();

-- ───────────────────────────── the attempt is still current ─────────────────────────────
-- Everything a pending booking request was granted for, re-checked (renewal and confirmation).
create function app.assert_booking_current(q public.quotes, br public.booking_requests)
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
  if q.expires_at is not null and q.expires_at <= now() then
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

-- ───────────────────────────── request (event binding) ─────────────────────────────
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
  -- 1. quote
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
  if q.expires_at is not null and q.expires_at <= now() then
    raise exception 'QUOTE_EXPIRED' using errcode = 'RA009';
  end if;
  if app.quote_event_mismatch(q) then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'event changed since the quote was priced';
  end if;

  -- 2. booking request
  select * into br from public.booking_requests b where b.quote_id = q.id and b.status = 'pending' for update;
  if found and (br.quote_revision is distinct from q.revision
                or br.pricing_calculation_id is distinct from q.pricing_calculation_id
                or br.event_signature is distinct from app.event_signature(q.event_id)
                or br.items_signature is distinct from app.quote_items_signature(q.id)) then
    -- Stale (should already have been closed by the revision/event triggers): close it, start fresh.
    perform app.close_pending_booking(q.id, 'Stale booking request replaced.');
    br := null;
  end if;
  if br.id is not null then
    select * into res from public.reservations r where r.id = br.reservation_id;
    if res.status = 'held' and res.hold_expires_at > now() then
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

  -- 3 + 4. availability (advisory locks, then reservation rows) inside reserve_inventory
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
  update public.reservations r set quote_id = q.id, event_id = q.event_id, booking_request_id = br.id where r.id = rid
  returning * into res;
  return query select br.id, res.id, res.hold_expires_at;
end;
$$;

-- ───────────────────────────── renewal re-verifies the attempt ─────────────────────────────
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
begin
  select * into l from app.lock_booking(p_booking_request_id);                                     -- 1–2
  actor := app.assert_can_act((l.br).organization_id, 'availability.write');
  perform app.assert_booking_current(l.q, l.br);
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
  return app.extend_held_reservation((l.br).reservation_id, true);                                  -- 3–4
end;
$$;

-- ───────────────────────────── THE confirmation path ─────────────────────────────
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
  -- quote status + expiry, revision, snapshot, customer/event links, event, items
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
  if res.status <> 'held' or res.hold_expires_at <= now() then
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  -- 3–4: variant locks, reservation row, hold still live, availability re-validated, weather.
  perform app.confirm_held_reservation(res.id, p_ignore_weather, 'staff');

  -- The confirmed request is what allows the quote to become 'accepted' (quotes_require_booking).
  update public.booking_requests set status = 'confirmed', decided_by = (select auth.uid()), decided_at = now()
  where id = br.id;
  update public.quotes set status = 'accepted' where id = q.id;
  return res.id;
end;
$$;

revoke execute on function
  app.quote_event_mismatch(public.quotes),
  app.assert_booking_current(public.quotes, public.booking_requests)
from public, anon, authenticated, service_role;
