-- M5 workflow boundaries (Codex review of b59a7ea). ADR 0015 §10.
--
-- 1+7 A booking request is bound to the exact quote revision, pricing snapshot, held items and
--     event. Revising / re-pricing a quote releases its hold; confirmation re-verifies everything
--     and rejects any mismatch (RA013 STALE_BOOKING_REQUEST). Expired holds are rejected, never
--     silently re-reserved.
-- 2   One confirmation path: the generic reservation functions refuse reservations that belong to
--     a quote/booking request; the internals are app.* functions nobody can call directly.
-- 3   Cancelling, declining or expiring a quote releases its hold and closes the request.
-- 4   One canonical lock order (below), used by every workflow function and trigger.
-- 5   Anonymous submissions never modify an existing customer; what they typed is kept on the quote.
-- 6   The renewal budget belongs to the booking attempt (quote + revision), not to one hold:
--     at most 1 + max_hold_renewals holds/extensions per revision for public/assistant callers.
--
-- CANONICAL LOCK ORDER (never acquire an earlier item while holding a later one):
--   1. quote row                (FOR UPDATE, or held by an UPDATE of the quote)
--   2. booking_request row      (FOR UPDATE)
--   3. organization advisory lock (shared/exclusive), then variant advisory locks in uuid order
--   4. reservation rows         (FOR UPDATE / UPDATE)
-- Functions that start from a booking request id read it WITHOUT a lock, lock its quote, then
-- lock the booking request and re-read it.

-- ───────────────────────────── schema ─────────────────────────────
alter table public.quotes
  add column revision integer not null default 1,
  add column submitted_contact jsonb
    check (submitted_contact is null or (jsonb_typeof(submitted_contact) = 'object' and pg_column_size(submitted_contact) <= 4096));

alter table public.booking_requests
  add column quote_revision integer,
  add column pricing_calculation_id uuid,
  add column items_signature text,
  add column event_signature text;

-- Holds granted + extensions per quote revision (the logical booking attempt).
create table public.quote_hold_budgets (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  quote_id        uuid not null,
  revision        integer not null,
  used            integer not null default 0 check (used >= 0),
  primary key (quote_id, revision),
  foreign key (organization_id, quote_id) references public.quotes (organization_id, id) on delete cascade
);
alter table public.quote_hold_budgets enable row level security;
alter table public.quote_hold_budgets force row level security;
revoke all on public.quote_hold_budgets from anon;
revoke insert, update, delete on public.quote_hold_budgets from authenticated;
create policy quote_hold_budgets_select on public.quote_hold_budgets for select to authenticated
  using ((select app.has_permission(organization_id, 'org.read')));
create trigger quote_hold_budgets_org_immutable before update on public.quote_hold_budgets
  for each row execute function app.prevent_organization_change();

-- ───────────────────────────── signatures ─────────────────────────────
-- Items (variant, rental period, total quantity) of a quote's current items / of a reservation.
create function app.quote_items_signature(p_quote_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(string_agg(format('%s|%s|%s|%s', x.variant_id, lower(x.p), upper(x.p), x.q), ';'
                             order by x.variant_id, lower(x.p), upper(x.p)), '')
  from (select i.variant_id, i.rental_period as p, sum(i.quantity) as q
        from public.quote_items i where i.quote_id = p_quote_id group by 1, 2) x
$$;

create function app.reservation_signature(p_reservation_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(string_agg(format('%s|%s|%s|%s', x.variant_id, lower(x.p), upper(x.p), x.q), ';'
                             order by x.variant_id, lower(x.p), upper(x.p)), '')
  from (select a.variant_id, a.rental_period as p, sum(a.quantity) as q
        from public.reservation_allocations a where a.reservation_id = p_reservation_id group by 1, 2) x
$$;

create function app.event_signature(p_event_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select md5(concat_ws('|', e.starts_at, e.ends_at, e.address_line1, e.address_line2, e.city, e.state,
                                        e.postal_code))
                   from public.events e where e.id = p_event_id), '')
$$;

-- ───────────────────────────── reservation internals (no client access) ─────────────────────────────
-- Callers are already authorized. Each takes the variant advisory locks, then the reservation row.

create function app.confirm_held_reservation(p_reservation_id uuid, p_ignore_weather boolean, p_actor text)
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
  if r.hold_expires_at <= now() then
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

create function app.extend_held_reservation(p_reservation_id uuid, p_enforce_hold_limit boolean)
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
  if r.hold_expires_at <= now() then
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  if p_enforce_hold_limit and r.hold_renewals >= s.max_hold_renewals then
    raise exception 'HOLD_RENEWAL_LIMIT' using errcode = 'RA007';
  end if;
  expires := now() + make_interval(mins => s.booking_hold_minutes);
  update public.reservations set hold_expires_at = expires, hold_renewals = hold_renewals + 1 where id = r.id;
  return expires;
end;
$$;

create function app.end_reservation(p_reservation_id uuid, p_actor text)
returns public.reservation_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.reservations;
  next_status public.reservation_status;
begin
  perform app.lock_reservation_variants(p_reservation_id);
  select * into r from public.reservations where id = p_reservation_id for update;
  if r.status in ('released', 'cancelled', 'completed') then
    return r.status;
  end if;
  if r.status = 'confirmed' and p_actor <> 'staff' then
    raise exception 'INVALID_STATE: only staff can cancel a confirmed booking' using errcode = 'RA006';
  end if;
  next_status := case when r.status = 'held' then 'released' else 'cancelled' end;
  update public.reservations set status = next_status, ended_at = now() where id = r.id;
  return next_status;
end;
$$;

-- A reservation that belongs to a quote / booking request is managed only by the booking functions.
create function app.assert_not_quote_managed(r public.reservations)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if r.booking_request_id is not null or r.quote_id is not null then
    raise exception 'INVALID_STATE: this hold belongs to a booking request; use the booking request actions'
      using errcode = 'RA010';
  end if;
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
begin
  select * into r from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  actor := app.assert_can_act(r.organization_id, 'availability.write');
  perform app.assert_not_quote_managed(r);
  perform app.confirm_held_reservation(r.id, p_ignore_weather, actor);
end;
$$;

create or replace function public.renew_hold(p_reservation_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.reservations;
begin
  select * into r from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.assert_can_act(r.organization_id, 'availability.write');
  perform app.assert_not_quote_managed(r);
  return app.extend_held_reservation(r.id, true);
end;
$$;

create or replace function public.release_reservation(p_reservation_id uuid)
returns public.reservation_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.reservations;
  actor text;
begin
  select * into r from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  actor := app.assert_can_act(r.organization_id, 'availability.write');
  perform app.assert_not_quote_managed(r);
  return app.end_reservation(r.id, actor);
end;
$$;

-- Holds are never confirmed by the server's system context.
revoke execute on function public.confirm_reservation(uuid, boolean) from service_role;

-- ───────────────────────────── quote revision, release on change ─────────────────────────────
create function app.quotes_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.pricing_calculation_id is distinct from old.pricing_calculation_id
     or new.price_request is distinct from old.price_request
     or new.event_id is distinct from old.event_id
     or new.customer_id is distinct from old.customer_id
     or (new.status = 'draft' and old.status <> 'draft') then
    new.revision := old.revision + 1;
  else
    new.revision := old.revision;          -- never writable directly
  end if;
  new.submitted_contact := old.submitted_contact;  -- what the visitor typed is a record, not editable
  return new;
end;
$$;
-- Runs after quotes_guard (alphabetical), which validates the transition itself.
create trigger quotes_revision before update on public.quotes
  for each row execute function app.quotes_revision();

-- Closes the pending booking request of a quote and releases its hold. Caller holds the quote
-- row (lock order step 1); this takes steps 2–4.
create function app.close_pending_booking(p_quote_id uuid, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  br public.booking_requests;
begin
  select * into br from public.booking_requests where quote_id = p_quote_id and status = 'pending' for update;
  if not found then
    return;
  end if;
  if br.reservation_id is not null then
    perform app.end_reservation(br.reservation_id, 'system');
  end if;
  update public.booking_requests
  set status = 'cancelled', decided_at = now(), decided_by = (select auth.uid()), decision_note = left(p_note, 1000)
  where id = br.id;
end;
$$;

create function app.quotes_release_holds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revision <> old.revision then
    perform app.close_pending_booking(new.id, format('Quote revised (revision %s); request the booking again.', new.revision));
  elsif new.status in ('cancelled', 'declined', 'expired') and new.status <> old.status then
    perform app.close_pending_booking(new.id, format('Quote %s.', new.status));
  end if;
  return null;
end;
$$;
create trigger quotes_release_holds after update on public.quotes
  for each row execute function app.quotes_release_holds();

-- ───────────────────────────── booking workflow (canonical lock order) ─────────────────────────────
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

  -- 2. booking request
  select * into br from public.booking_requests b where b.quote_id = q.id and b.status = 'pending' for update;
  if found and (br.quote_revision is distinct from q.revision or br.pricing_calculation_id is distinct from q.pricing_calculation_id) then
    -- Stale (should already have been closed by the revision trigger): close it, start fresh.
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

-- Locks quote then booking request (steps 1–2) for a booking request id; returns both.
create function app.lock_booking(p_booking_request_id uuid, out q public.quotes, out br public.booking_requests)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  qid uuid;
begin
  select b.quote_id into qid from public.booking_requests b where b.id = p_booking_request_id;   -- no lock
  if qid is null then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  select * into q from public.quotes where id = qid for update;                                    -- 1
  select * into br from public.booking_requests where id = p_booking_request_id for update;       -- 2
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
begin
  select * into l from app.lock_booking(p_booking_request_id);
  actor := app.assert_can_act((l.br).organization_id, 'availability.write');
  if (l.br).status <> 'pending' then
    raise exception 'INVALID_STATE: booking request is %', (l.br).status using errcode = 'RA010';
  end if;
  if (l.br).quote_revision is distinct from (l.q).revision then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013';
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
  return app.extend_held_reservation((l.br).reservation_id, true);                                  -- 3–4
end;
$$;

-- THE confirmation path. Verifies, in order, everything the hold was granted for, and never
-- repairs a mismatch: a stale or expired request must be requested again.
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
     or br.pricing_calculation_id is distinct from q.pricing_calculation_id then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'quote revision or pricing snapshot changed';
  end if;
  if q.manual_review_required and q.review_approved_at is null then
    raise exception 'REVIEW_REQUIRED' using errcode = 'RA008';
  end if;
  if br.items_signature is distinct from app.quote_items_signature(q.id)
     or br.items_signature is distinct from app.reservation_signature(br.reservation_id) then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'held items differ from the quote';
  end if;
  if br.event_signature is distinct from app.event_signature(q.event_id) then
    raise exception 'STALE_BOOKING_REQUEST' using errcode = 'RA013', detail = 'event changed after the hold';
  end if;
  select * into res from public.reservations where id = br.reservation_id;                        -- read only
  if res.status <> 'held' or res.hold_expires_at <= now() then
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  -- 3–4: variant locks, reservation row, hold still live, availability re-validated, weather.
  perform app.confirm_held_reservation(res.id, p_ignore_weather, 'staff');

  update public.quotes set status = 'accepted' where id = q.id;
  update public.booking_requests set status = 'confirmed', decided_by = (select auth.uid()), decided_at = now()
  where id = br.id;
  return res.id;
end;
$$;

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
    perform app.end_reservation((l.br).reservation_id, actor);                                      -- 3–4
  end if;
  update public.booking_requests
  set status = p_status, decided_by = (select auth.uid()), decided_at = now(), decision_note = left(p_note, 1000)
  where id = (l.br).id;
end;
$$;

-- ───────────────────────────── customers: no enrichment from anonymous input ─────────────────────────────
create or replace function public.match_or_create_customer(p_organization_id uuid, p_customer jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := app.assert_can_act(p_organization_id, 'customers.write');
  v_email text := lower(nullif(btrim(p_customer ->> 'email'), ''));
  v_phone text := nullif(btrim(p_customer ->> 'phone'), '');
  v_id uuid;
  v_source text := coalesce(p_customer ->> 'source', case when actor = 'staff' then 'admin' else 'web' end);
begin
  if v_email is null and v_phone is null then
    raise exception 'INVALID_REQUEST: email or phone required' using errcode = 'RA006';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('customers:' || p_organization_id::text, 0));

  select id into v_id from public.customers
  where organization_id = p_organization_id and lower(email::text) = v_email and v_email is not null;
  if v_id is null and v_phone is not null then
    select id into v_id from public.customers where organization_id = p_organization_id and phone_e164 = v_phone;
  end if;

  if v_id is null then
    insert into public.customers (organization_id, first_name, last_name, company_name, email, phone_e164,
                                  sms_opt_in, email_opt_in, source)
    values (p_organization_id, nullif(btrim(p_customer ->> 'firstName'), ''), nullif(btrim(p_customer ->> 'lastName'), ''),
            nullif(btrim(p_customer ->> 'companyName'), ''), v_email, v_phone,
            coalesce((p_customer ->> 'smsOptIn')::boolean, false), coalesce((p_customer ->> 'emailOptIn')::boolean, false),
            v_source)
    returning id into v_id;
  elsif actor = 'staff' then
    -- Staff may fill empty fields explicitly; an anonymous visitor who merely knows an email or
    -- phone number never changes an existing record (their input stays on the quote instead).
    update public.customers c set
      first_name = coalesce(c.first_name, nullif(btrim(p_customer ->> 'firstName'), '')),
      last_name = coalesce(c.last_name, nullif(btrim(p_customer ->> 'lastName'), '')),
      company_name = coalesce(c.company_name, nullif(btrim(p_customer ->> 'companyName'), '')),
      email = coalesce(c.email, case when not exists (
        select 1 from public.customers o where o.organization_id = c.organization_id and lower(o.email::text) = v_email) then v_email end),
      phone_e164 = coalesce(c.phone_e164, case when not exists (
        select 1 from public.customers o where o.organization_id = c.organization_id and o.phone_e164 = v_phone) then v_phone end),
      archived_at = null
    where c.id = v_id;
  end if;
  return v_id;
end;
$$;

-- create_quote records what a visitor typed (never merged into the customer record).
drop function public.create_quote(uuid, uuid, uuid, uuid, jsonb, text, text, text, text);
create function public.create_quote(
  p_organization_id uuid, p_customer_id uuid, p_event_id uuid, p_calculation_id uuid, p_price_request jsonb,
  p_source text, p_token_hash text default null, p_customer_notes text default null, p_internal_notes text default null,
  p_submitted_contact jsonb default null
)
returns table (quote_id uuid, quote_number text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := app.assert_can_act(p_organization_id, 'quotes.write');
  q public.quotes;
begin
  if (actor = 'staff' and p_source <> 'admin')
     or (actor = 'system' and (p_source not in ('web', 'assistant') or p_internal_notes is not null)) then
    raise exception 'INVALID_REQUEST: source' using errcode = 'RA006';
  end if;
  if p_calculation_id is null then
    raise exception 'INVALID_REQUEST: a quote needs a pricing calculation' using errcode = 'RA006';
  end if;
  insert into public.quotes (organization_id, customer_id, event_id, source, price_request, pricing_calculation_id,
                             token_hash, customer_notes, internal_notes, created_by_type, submitted_contact)
  values (p_organization_id, p_customer_id, p_event_id, p_source, p_price_request, p_calculation_id,
          p_token_hash, left(p_customer_notes, 4000), left(p_internal_notes, 4000),
          case when actor = 'staff' then 'user' when p_source = 'assistant' then 'ai' else 'public' end::public.audit_actor_type,
          p_submitted_contact)
  returning * into q;
  return query select q.id, q.quote_number;
end;
$$;

-- ───────────────────────────── grants ─────────────────────────────
revoke execute on function
  app.quote_items_signature(uuid),
  app.reservation_signature(uuid),
  app.event_signature(uuid),
  app.confirm_held_reservation(uuid, boolean, text),
  app.extend_held_reservation(uuid, boolean),
  app.end_reservation(uuid, text),
  app.assert_not_quote_managed(public.reservations),
  app.quotes_revision(),
  app.close_pending_booking(uuid, text),
  app.quotes_release_holds(),
  app.lock_booking(uuid)
from public;
revoke execute on function public.create_quote(uuid, uuid, uuid, uuid, jsonb, text, text, text, text, jsonb) from public, anon;
grant execute on function public.create_quote(uuid, uuid, uuid, uuid, jsonb, text, text, text, text, jsonb)
  to authenticated, service_role;
