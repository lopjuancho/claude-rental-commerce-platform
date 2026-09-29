-- M3 decision (Codex M5-HARDENING-REVIEW.md): per-visitor cap on concurrent live PUBLIC holds.
-- ADR 0015 §14.
--
-- - Identity: the SHA-256 of a server-issued, opaque, 256-bit anonymous visitor token (HttpOnly
--   cookie). The raw token never reaches the database; emails and IPs are not the identity.
-- - Policy: at most organization_settings.max_public_holds_per_visitor (default 2) live public
--   holds per visitor per organization. Only held + unexpired holds created for a public/assistant
--   caller count; released, cancelled, declined, expired and confirmed ones do not. Staff holds are
--   exempt. A new quote does not help: the count is per visitor, not per quote.
-- - Atomic: request_booking takes a per-(organization, visitor) advisory lock, counts with
--   clock_timestamp() and creates the hold in the same transaction.
-- - The per-quote renewal budget (quote_hold_budgets) and the per-client-IP rate limit still apply.

alter table public.organization_settings
  add column max_public_holds_per_visitor integer not null default 2
    check (max_public_holds_per_visitor between 1 and 50);

alter table public.reservations
  add column public_visitor_hash text check (public_visitor_hash ~ '^[0-9a-f]{64}$');
create index reservations_live_public_holds_idx on public.reservations (organization_id, public_visitor_hash)
  where status = 'held' and public_visitor_hash is not null;

-- The visitor a hold was granted to is part of its immutable identity once it belongs to a request.
create or replace function app.reservations_guard_quote_managed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.booking_request_id is null and old.quote_id is null then
    return new;
  end if;
  if (new.booking_request_id, new.quote_id, new.event_id, new.organization_id, new.public_visitor_hash)
     is distinct from (old.booking_request_id, old.quote_id, old.event_id, old.organization_id, old.public_visitor_hash)
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

-- request_booking gains the visitor; the old signature is replaced (callers use named/positional
-- arguments that remain valid: staff pass 1–3 arguments, the server's token path passes 4).
drop function public.request_booking_by_token(uuid, text, text, text);
drop function public.request_booking(uuid, text, text);

create function public.request_booking(p_quote_id uuid, p_source text default 'web', p_message text default null,
                                       p_visitor_hash text default null)
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
  -- A public (non-staff) hold always belongs to an anonymous visitor: the SHA-256 of the
  -- server-issued visitor token, never an email or IP. Without one there is no public hold.
  if actor <> 'staff' and (p_visitor_hash is null or p_visitor_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'INVALID_REQUEST: visitor' using errcode = 'RA006';
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

  -- Per-visitor cap on concurrent live public holds (per organization; staff exempt). The visitor
  -- lock serializes this visitor's requests, and the count is taken after it with the clock, so
  -- the check and the hold below are atomic. Lock order: quote → request → variants → visitor →
  -- reservation rows (reserve_inventory below only re-enters variant locks already held).
  if actor <> 'staff' then
    perform pg_advisory_xact_lock(hashtextextended('visitor:' || q.organization_id::text || ':' || p_visitor_hash, 0));
    select s.max_public_holds_per_visitor into max_holds from public.organization_settings s
    where s.organization_id = q.organization_id;
    select count(*) into used from public.reservations r
    where r.organization_id = q.organization_id and r.public_visitor_hash = p_visitor_hash
      and r.status = 'held' and r.hold_expires_at > clock_timestamp();
    if used >= max_holds then
      raise exception 'PUBLIC_HOLD_LIMIT' using errcode = 'RA015',
        detail = format('%s live holds (limit %s)', used, max_holds);
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
      hold_expires_at = least(r.hold_expires_at, q.expires_at),
      public_visitor_hash = case when actor <> 'staff' then p_visitor_hash end
  where r.id = rid
  returning * into res;
  return query select br.id, res.id, res.hold_expires_at;
end;
$$;

create function public.request_booking_by_token(p_organization_id uuid, p_token_hash text, p_source text,
                                                 p_message text default null, p_visitor_hash text default null)
returns table (booking_request_id uuid, reservation_id uuid, hold_expires_at timestamptz, quote_number text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  q public.quotes;
begin
  perform app.require_service_role();
  if p_source not in ('web', 'assistant') then
    raise exception 'INVALID_REQUEST: source' using errcode = 'RA006';
  end if;
  if p_visitor_hash is null or p_visitor_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST: visitor' using errcode = 'RA006';
  end if;
  q := app.quote_by_token(p_organization_id, p_token_hash);
  return query select b.booking_request_id, b.reservation_id, b.hold_expires_at, q.quote_number
               from public.request_booking(q.id, p_source, p_message, p_visitor_hash) b;
end;
$$;

revoke execute on function public.request_booking(uuid, text, text, text) from public, anon;
grant execute on function public.request_booking(uuid, text, text, text) to authenticated, service_role;
revoke execute on function public.request_booking_by_token(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_booking_by_token(uuid, text, text, text, text) to service_role;
