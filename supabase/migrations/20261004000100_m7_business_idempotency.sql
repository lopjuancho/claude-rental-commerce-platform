-- M7 review round 2 (ADR 0017 §11): the business writes themselves are idempotent.
--
-- The conversation lease is not enough: a turn whose lease expired may still be inside a business
-- write when a replacement attempt starts the same one. So every assistant business write carries
-- the journal's idempotency key INTO the write: `*_once` wrappers take a transaction-scoped lock
-- on (organization, key), return the object already created under that key, or run the unchanged
-- M5 function and record the key → object mapping in the SAME transaction. However many workers
-- race, and whenever an old one finishes, one key yields exactly one event, one quote, one
-- booking request. (The web flow is unchanged and does not use keys.)
--
-- The journal's pending recovery data becomes immutable: a retry resolves the earlier attempt with
-- the data IT recorded and never overwrites it.

create table public.ai_business_keys (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  kind            text not null check (kind in ('event', 'quote', 'booking')),
  object_id       uuid not null,
  created_at      timestamptz not null default now(),
  primary key (organization_id, idempotency_key, kind)
);
create trigger ai_business_keys_org_immutable before update on public.ai_business_keys
  for each row execute function app.prevent_organization_change();
alter table public.ai_business_keys enable row level security;
alter table public.ai_business_keys force row level security;
revoke all on public.ai_business_keys from anon;
revoke insert, update, delete, truncate on public.ai_business_keys from authenticated;
create policy ai_business_keys_select on public.ai_business_keys for select to authenticated
  using ((select app.has_permission(organization_id, 'org.read')));

create function app.ai_business_lock(p_organization_id uuid, p_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST: idempotency key' using errcode = 'RA006';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_key, 0));
end;
$$;

create function public.create_event_once(p_organization_id uuid, p_customer_id uuid, p_event jsonb, p_key text)
returns table (event_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing uuid;
  r record;
begin
  perform app.require_service_role();
  perform app.ai_business_lock(p_organization_id, p_key);
  select k.object_id into existing from public.ai_business_keys k
  where k.organization_id = p_organization_id and k.idempotency_key = p_key and k.kind = 'event';
  if found then
    return query select e.id, e.starts_at, e.ends_at from public.events e
                 where e.organization_id = p_organization_id and e.id = existing;
    return;
  end if;
  select * into r from public.create_event(p_organization_id, p_customer_id, p_event);
  insert into public.ai_business_keys (organization_id, idempotency_key, kind, object_id)
  values (p_organization_id, p_key, 'event', r.event_id);
  return query select r.event_id, r.starts_at, r.ends_at;
end;
$$;

create function public.create_quote_once(
  p_organization_id uuid, p_customer_id uuid, p_event_id uuid, p_calculation_id uuid, p_price_request jsonb,
  p_source text, p_token_hash text, p_customer_notes text, p_submitted_contact jsonb, p_key text
)
returns table (quote_id uuid, quote_number text, token_hash text, created boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing uuid;
  r record;
begin
  perform app.require_service_role();
  perform app.ai_business_lock(p_organization_id, p_key);
  select k.object_id into existing from public.ai_business_keys k
  where k.organization_id = p_organization_id and k.idempotency_key = p_key and k.kind = 'quote';
  if found then
    return query select q.id, q.quote_number, q.token_hash, false from public.quotes q
                 where q.organization_id = p_organization_id and q.id = existing;
    return;
  end if;
  select * into r from public.create_quote(p_organization_id, p_customer_id, p_event_id, p_calculation_id,
                                           p_price_request, p_source, p_token_hash, p_customer_notes, null,
                                           p_submitted_contact);
  insert into public.ai_business_keys (organization_id, idempotency_key, kind, object_id)
  values (p_organization_id, p_key, 'quote', r.quote_id);
  return query select r.quote_id, r.quote_number, p_token_hash, true;
end;
$$;

create function public.request_booking_by_token_once(
  p_organization_id uuid, p_token_hash text, p_source text, p_message text, p_visitor_hash text, p_key text
)
returns table (booking_request_id uuid, reservation_id uuid, hold_expires_at timestamptz, quote_number text,
               created boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing uuid;
  r record;
begin
  perform app.require_service_role();
  perform app.ai_business_lock(p_organization_id, p_key);
  select k.object_id into existing from public.ai_business_keys k
  where k.organization_id = p_organization_id and k.idempotency_key = p_key and k.kind = 'booking';
  if found then
    -- The same request, as it is NOW (its hold may since have expired or been confirmed).
    return query select b.id, b.reservation_id, res.hold_expires_at, q.quote_number, false
                 from public.booking_requests b
                 join public.quotes q on q.id = b.quote_id
                 left join public.reservations res on res.id = b.reservation_id
                 where b.organization_id = p_organization_id and b.id = existing;
    return;
  end if;
  select * into r from public.request_booking_by_token(p_organization_id, p_token_hash, p_source, p_message,
                                                       p_visitor_hash);
  insert into public.ai_business_keys (organization_id, idempotency_key, kind, object_id)
  values (p_organization_id, p_key, 'booking', r.booking_request_id);
  return query select r.booking_request_id, r.reservation_id, r.hold_expires_at, r.quote_number, true;
end;
$$;

-- What (if anything) was created under a key: the recovery lookup for an attempt that never
-- recorded its outcome.
create function public.ai_business_object(p_organization_id uuid, p_key text, p_kind text)
returns table (object_id uuid, quote_number text, token_hash text, booking_status text,
               hold_expires_at timestamptz, hold_active boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_service_role();
  if p_kind = 'quote' then
    return query select q.id, q.quote_number, q.token_hash, null::text, null::timestamptz, null::boolean
                 from public.ai_business_keys k join public.quotes q on q.id = k.object_id
                 where k.organization_id = p_organization_id and k.idempotency_key = p_key and k.kind = 'quote'
                   and q.organization_id = p_organization_id;
  elsif p_kind = 'booking' then
    return query select b.id, q.quote_number, q.token_hash, b.status::text, res.hold_expires_at,
                        (b.status = 'pending' and res.status = 'held' and res.hold_expires_at > now())
                 from public.ai_business_keys k join public.booking_requests b on b.id = k.object_id
                 join public.quotes q on q.id = b.quote_id
                 left join public.reservations res on res.id = b.reservation_id
                 where k.organization_id = p_organization_id and k.idempotency_key = p_key and k.kind = 'booking'
                   and b.organization_id = p_organization_id;
  else
    raise exception 'INVALID_REQUEST: kind' using errcode = 'RA006';
  end if;
end;
$$;

-- Pending recovery data is written once and never replaced: a retry resolves the earlier attempt
-- with what that attempt recorded (the outcome "unknown" returns it unchanged).
create or replace function public.ai_mutation_begin(
  p_organization_id uuid,
  p_turn_id uuid,
  p_attempt integer,
  p_mutation_key text,
  p_tool_name text,
  p_tool_call_id text,
  p_pending jsonb
)
returns table (outcome text, mutation_id uuid, pending jsonb, ref jsonb, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.ai_conversations;
  m public.ai_mutations;
begin
  perform app.require_service_role();
  if p_mutation_key !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST: mutation key' using errcode = 'RA006';
  end if;
  c := app.ai_owned_conversation(p_organization_id, p_turn_id, p_attempt, true);
  select * into m from public.ai_mutations x
  where x.conversation_id = c.id and x.mutation_key = p_mutation_key
  for update;
  if not found then
    insert into public.ai_mutations (organization_id, conversation_id, turn_id, attempt, tool_name,
                                     tool_call_id, mutation_key, status, pending)
    values (p_organization_id, c.id, p_turn_id, p_attempt, p_tool_name, left(p_tool_call_id, 64),
            p_mutation_key, 'started', p_pending)
    returning * into m;
    return query select 'proceed'::text, m.id, m.pending, null::jsonb, null::jsonb;
    return;
  end if;
  if m.status = 'committed' then
    return query select 'replay'::text, m.id, m.pending, m.ref, m.result;
    return;
  end if;
  if m.status = 'started' and m.turn_id = p_turn_id and m.attempt = p_attempt then
    return query select 'in_progress'::text, m.id, m.pending, null::jsonb, null::jsonb;
    return;
  end if;
  -- Taken over by this attempt; the recorded pending data is kept as it is.
  update public.ai_mutations x
     set turn_id = p_turn_id, attempt = p_attempt, tool_call_id = left(p_tool_call_id, 64),
         status = 'started', error_code = null, started_at = now(),
         pending = coalesce(x.pending, p_pending)
   where x.id = m.id
  returning * into m;
  return query select 'unknown'::text, m.id, m.pending, null::jsonb, null::jsonb;
end;
$$;

revoke execute on function app.ai_business_lock(uuid, text),
  public.create_event_once(uuid, uuid, jsonb, text),
  public.create_quote_once(uuid, uuid, uuid, uuid, jsonb, text, text, text, jsonb, text),
  public.request_booking_by_token_once(uuid, text, text, text, text, text),
  public.ai_business_object(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_event_once(uuid, uuid, jsonb, text),
  public.create_quote_once(uuid, uuid, uuid, uuid, jsonb, text, text, text, jsonb, text),
  public.request_booking_by_token_once(uuid, text, text, text, text, text),
  public.ai_business_object(uuid, text, text)
  to service_role;
