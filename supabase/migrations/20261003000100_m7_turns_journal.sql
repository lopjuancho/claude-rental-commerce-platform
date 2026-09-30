-- M7 review (ADR 0017 §11): durable assistant turns and a mutation journal.
--
-- Invariant: a retry, a provider failure, a lost response or a concurrent turn never repeats a
-- business mutation (quote, booking request) and never loses the only reference to one that
-- committed.
--
-- - ai_turns: one row per client message (request key). A conversation has at most ONE active
--   turn (lease), claimed atomically before any tool runs; a second concurrent turn is refused
--   before it can mutate anything. A completed turn is replayed for the same request key.
-- - ai_mutations: one row per business mutation, keyed by a semantic idempotency key
--   (conversation + what is being created). It is claimed ('started') only by the active turn,
--   before the mutation runs, and 'committed' with its reference right after the service returns,
--   before the model is called again. Committed references are re-applied to the conversation
--   state on the next turn, whatever happened to the turn that made them.
--
-- The old optimistic open/append functions are replaced by begin/finish/fail.

alter table public.ai_conversations
  add column active_turn_id          uuid,
  add column active_turn_attempt     integer,
  add column active_turn_expires_at  timestamptz,
  add column applied_mutation_seq    bigint not null default 0;

create table public.ai_turns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  conversation_id  uuid not null,
  -- Client-generated per message; a retry of the same message reuses it.
  request_key      text not null check (request_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  attempt          integer not null default 1 check (attempt >= 1),
  status           text not null check (status in ('processing', 'completed', 'failed', 'abandoned')),
  lease_expires_at timestamptz not null,
  -- The reply returned for a completed turn (replayed on a duplicate request). Never contains a
  -- quote link token: the server strips it before storing.
  response         jsonb check (response is null or pg_column_size(response) <= 65536),
  error_code       text check (length(error_code) <= 60),
  correlation_id   text check (length(correlation_id) <= 80),
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  unique (organization_id, id),
  unique (conversation_id, request_key),
  foreign key (organization_id, conversation_id)
    references public.ai_conversations (organization_id, id) on delete cascade
);

create table public.ai_mutations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  conversation_id  uuid not null,
  seq              bigint generated always as identity,
  turn_id          uuid not null,
  attempt          integer not null,
  tool_name        text not null check (tool_name ~ '^[a-z_]{1,40}$'),
  tool_call_id     text check (length(tool_call_id) <= 64),
  -- sha256 hex of (conversation, mutation kind, semantic input): the same request is one mutation.
  mutation_key     text not null check (mutation_key ~ '^[0-9a-f]{64}$'),
  status           text not null check (status in ('started', 'committed', 'failed')),
  -- What an attempt needs to find its own outcome if it never recorded one (e.g. the quote token
  -- HASH chosen before creating the quote).
  pending          jsonb check (pending is null or pg_column_size(pending) <= 4096),
  -- The committed reference applied to the conversation (quote/booking identity and basis).
  ref              jsonb check (ref is null or pg_column_size(ref) <= 32768),
  -- The tool outcome as the model and the customer saw it (no quote link token).
  result           jsonb check (result is null or pg_column_size(result) <= 65536),
  error_code       text check (length(error_code) <= 60),
  started_at       timestamptz not null default now(),
  committed_at     timestamptz,
  unique (conversation_id, mutation_key),
  foreign key (organization_id, conversation_id)
    references public.ai_conversations (organization_id, id) on delete cascade,
  foreign key (organization_id, turn_id)
    references public.ai_turns (organization_id, id) on delete cascade
);
create index ai_mutations_conversation_seq_idx on public.ai_mutations (conversation_id, seq);

do $$
declare
  t text;
begin
  foreach t in array array['ai_turns', 'ai_mutations'] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.prevent_organization_change()', t || '_org_immutable', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated
                     using ((select app.has_permission(organization_id, 'org.read')))$p$, t || '_select', t);
  end loop;
end $$;

drop function public.ai_conversation_open(uuid, text);
drop function public.ai_conversation_append(uuid, uuid, integer, jsonb, uuid, jsonb, integer, integer, text);

-- ───────────────────────────── turns ─────────────────────────────

-- Claims the conversation for one turn. Outcomes:
--   started     — this call owns the conversation until finish/fail or the lease expires;
--   replay      — this request key already completed: its stored response is returned;
--   in_progress — this request key is being processed right now (duplicate POST);
--   busy        — another message of this conversation is being processed.
-- An expired lease is taken over (the old turn is marked abandoned). A request key that failed or
-- was abandoned is retried as the next attempt of the same turn.
create function public.ai_turn_begin(
  p_organization_id uuid,
  p_session_hash text,
  p_request_key text,
  p_lease_seconds integer,
  p_correlation_id text
)
returns table (
  outcome text,
  turn_id uuid,
  attempt integer,
  conversation_id uuid,
  state jsonb,
  state_version integer,
  message_count integer,
  applied_mutation_seq bigint,
  response jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.ai_conversations;
  t public.ai_turns;
begin
  perform app.require_service_role();
  if p_session_hash !~ '^[0-9a-f]{64}$' or p_request_key !~ '^[A-Za-z0-9_-]{8,64}$'
     or p_lease_seconds not between 5 and 600 then
    raise exception 'INVALID_REQUEST: turn' using errcode = 'RA006';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_organization_id and o.status = 'active') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  insert into public.ai_conversations (organization_id, session_hash)
  values (p_organization_id, p_session_hash)
  on conflict (organization_id, session_hash) do nothing;
  select * into c from public.ai_conversations a
  where a.organization_id = p_organization_id and a.session_hash = p_session_hash
  for update;

  select * into t from public.ai_turns x
  where x.conversation_id = c.id and x.request_key = p_request_key
  for update;
  if found then
    if t.status = 'completed' then
      return query select 'replay'::text, t.id, t.attempt, c.id, c.state, c.state_version,
                          c.message_count, c.applied_mutation_seq, t.response;
      return;
    end if;
    if t.status = 'processing' and t.lease_expires_at > now() then
      return query select 'in_progress'::text, t.id, t.attempt, c.id, null::jsonb, c.state_version,
                          c.message_count, c.applied_mutation_seq, null::jsonb;
      return;
    end if;
  end if;

  if c.active_turn_id is not null and c.active_turn_expires_at > now()
     and (t.id is null or c.active_turn_id <> t.id) then
    return query select 'busy'::text, null::uuid, null::integer, c.id, null::jsonb, c.state_version,
                        c.message_count, c.applied_mutation_seq, null::jsonb;
    return;
  end if;
  if c.active_turn_id is not null then
    update public.ai_turns x set status = 'abandoned', error_code = 'LEASE_EXPIRED', completed_at = now()
     where x.id = c.active_turn_id and x.status = 'processing';
  end if;

  -- Retention: an expired conversation starts over (its journal stays, but is not re-applied).
  if c.expires_at <= now() then
    delete from public.ai_messages m where m.conversation_id = c.id;
    update public.ai_conversations a
       set state = '{}'::jsonb, state_version = a.state_version + 1, quote_id = null,
           message_count = 0, tool_call_count = 0, token_usage = 0,
           applied_mutation_seq = coalesce((select max(j.seq) from public.ai_mutations j
                                            where j.conversation_id = a.id), 0),
           expires_at = now() + interval '30 days'
     where a.id = c.id
    returning * into c;
  end if;

  if t.id is not null then
    update public.ai_turns x
       set attempt = x.attempt + 1, status = 'processing',
           lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           error_code = null, response = null, correlation_id = p_correlation_id,
           started_at = now(), completed_at = null
     where x.id = t.id
    returning * into t;
  else
    insert into public.ai_turns (organization_id, conversation_id, request_key, status,
                                 lease_expires_at, correlation_id)
    values (p_organization_id, c.id, p_request_key, 'processing',
            now() + make_interval(secs => p_lease_seconds), p_correlation_id)
    returning * into t;
  end if;
  update public.ai_conversations a
     set active_turn_id = t.id, active_turn_attempt = t.attempt,
         active_turn_expires_at = t.lease_expires_at
   where a.id = c.id;
  return query select 'started'::text, t.id, t.attempt, c.id, c.state, c.state_version,
                      c.message_count, c.applied_mutation_seq, null::jsonb;
end;
$$;

-- Locks the conversation and checks that (turn, attempt) still owns it.
create function app.ai_owned_conversation(
  p_organization_id uuid, p_turn_id uuid, p_attempt integer, p_require_lease boolean
)
returns public.ai_conversations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.ai_conversations;
begin
  select a.* into c from public.ai_conversations a
  join public.ai_turns t on t.conversation_id = a.id
  where t.id = p_turn_id and t.organization_id = p_organization_id and a.organization_id = p_organization_id
  for update of a;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if c.active_turn_id is distinct from p_turn_id or c.active_turn_attempt is distinct from p_attempt
     or (p_require_lease and c.active_turn_expires_at <= now()) then
    raise exception 'CONFLICT: this turn no longer owns the conversation' using errcode = 'RA010';
  end if;
  return c;
end;
$$;

-- Completes the owning turn: appends its messages, stores the state and the replayable response,
-- releases the conversation. Allowed after the lease if nobody took over.
create function public.ai_turn_finish(
  p_organization_id uuid,
  p_turn_id uuid,
  p_attempt integer,
  p_state jsonb,
  p_quote_id uuid,
  p_messages jsonb,
  p_tool_calls integer,
  p_tokens integer,
  p_prompt_version text,
  p_applied_seq bigint,
  p_response jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.ai_conversations;
  next_seq integer;
  m jsonb;
begin
  perform app.require_service_role();
  c := app.ai_owned_conversation(p_organization_id, p_turn_id, p_attempt, false);
  if jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) > 40 then
    raise exception 'INVALID_REQUEST: messages' using errcode = 'RA006';
  end if;
  select coalesce(max(x.seq), 0) + 1 into next_seq from public.ai_messages x where x.conversation_id = c.id;
  for m in select value from jsonb_array_elements(p_messages) loop
    insert into public.ai_messages (organization_id, conversation_id, seq, role, content, structured)
    values (p_organization_id, c.id, next_seq, m ->> 'role', m ->> 'content',
            case when m ? 'structured' then m -> 'structured' else null end);
    next_seq := next_seq + 1;
  end loop;
  update public.ai_conversations a
     set state = p_state,
         state_version = a.state_version + 1,
         quote_id = p_quote_id,
         applied_mutation_seq = greatest(a.applied_mutation_seq, coalesce(p_applied_seq, 0)),
         message_count = a.message_count + jsonb_array_length(p_messages),
         tool_call_count = a.tool_call_count + greatest(p_tool_calls, 0),
         token_usage = a.token_usage + greatest(p_tokens, 0),
         prompt_version = p_prompt_version,
         last_message_at = now(),
         expires_at = greatest(a.expires_at, now() + interval '30 days'),
         active_turn_id = null, active_turn_attempt = null, active_turn_expires_at = null
   where a.id = c.id;
  update public.ai_turns t
     set status = 'completed', response = p_response, completed_at = now()
   where t.id = p_turn_id;
  return c.state_version + 1;
end;
$$;

-- Ends the owning turn without a reply (provider failure, timeout). The state — including the
-- references of mutations this turn committed — is kept when given; the messages are not.
create function public.ai_turn_fail(
  p_organization_id uuid,
  p_turn_id uuid,
  p_attempt integer,
  p_error_code text,
  p_state jsonb,
  p_quote_id uuid,
  p_applied_seq bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.ai_conversations;
begin
  perform app.require_service_role();
  begin
    c := app.ai_owned_conversation(p_organization_id, p_turn_id, p_attempt, false);
  exception when sqlstate 'RA010' then
    -- Taken over already: the journal still holds this turn's committed mutations.
    update public.ai_turns t set status = 'failed', error_code = left(p_error_code, 60), completed_at = now()
     where t.id = p_turn_id and t.organization_id = p_organization_id
       and t.attempt = p_attempt and t.status = 'processing';
    return;
  end;
  update public.ai_conversations a
     set state = coalesce(p_state, a.state),
         state_version = a.state_version + case when p_state is null then 0 else 1 end,
         quote_id = case when p_state is null then a.quote_id else p_quote_id end,
         applied_mutation_seq = greatest(a.applied_mutation_seq, coalesce(p_applied_seq, 0)),
         active_turn_id = null, active_turn_attempt = null, active_turn_expires_at = null
   where a.id = c.id;
  update public.ai_turns t
     set status = 'failed', error_code = left(p_error_code, 60), completed_at = now()
   where t.id = p_turn_id;
end;
$$;

-- ───────────────────────────── mutation journal ─────────────────────────────

-- Claims one mutation for the owning turn (lease required: no mutation starts after it). Outcomes:
--   proceed     — run the mutation, then ai_mutation_commit (or ai_mutation_fail);
--   replay      — already committed: use the stored ref/result, do not run it again;
--   unknown     — an earlier attempt started it and never recorded the outcome: resolve it from
--                 `pending` (e.g. look the quote up by its token hash) before running it again;
--   in_progress — this same attempt already claimed it.
create function public.ai_mutation_begin(
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
  previous jsonb;
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
  previous := case when m.status = 'started' then m.pending else null end;
  update public.ai_mutations x
     set turn_id = p_turn_id, attempt = p_attempt, tool_call_id = left(p_tool_call_id, 64),
         status = 'started', pending = p_pending, error_code = null, started_at = now()
   where x.id = m.id;
  return query select case when previous is null then 'proceed' else 'unknown' end, m.id,
                      coalesce(previous, p_pending), null::jsonb, null::jsonb;
end;
$$;

-- Records a committed mutation. Not lease-fenced: a mutation that completed must be recorded even
-- if its turn ran out of time. Idempotent.
create function public.ai_mutation_commit(
  p_organization_id uuid,
  p_mutation_id uuid,
  p_ref jsonb,
  p_result jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m public.ai_mutations;
begin
  perform app.require_service_role();
  select * into m from public.ai_mutations x
  where x.id = p_mutation_id and x.organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if m.status <> 'committed' then
    update public.ai_mutations x
       set status = 'committed', ref = p_ref, result = p_result, committed_at = now(), error_code = null
     where x.id = m.id;
  end if;
  return m.seq;
end;
$$;

-- The mutation definitely did not happen (the service refused it): a later identical request may
-- run it again.
create function public.ai_mutation_fail(p_organization_id uuid, p_mutation_id uuid, p_error_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.require_service_role();
  update public.ai_mutations x
     set status = 'failed', error_code = left(p_error_code, 60)
   where x.id = p_mutation_id and x.organization_id = p_organization_id and x.status = 'started';
end;
$$;

-- Committed mutations after a sequence number, oldest first (re-applied to the state on load).
create function public.ai_conversation_mutations(p_organization_id uuid, p_conversation_id uuid, p_after_seq bigint)
returns table (seq bigint, tool_name text, ref jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_service_role();
  return query
  select m.seq, m.tool_name, m.ref from public.ai_mutations m
  where m.organization_id = p_organization_id and m.conversation_id = p_conversation_id
    and m.status = 'committed' and m.seq > p_after_seq
  order by m.seq
  limit 50;
end;
$$;

revoke execute on function public.ai_turn_begin(uuid, text, text, integer, text),
  app.ai_owned_conversation(uuid, uuid, integer, boolean),
  public.ai_turn_finish(uuid, uuid, integer, jsonb, uuid, jsonb, integer, integer, text, bigint, jsonb),
  public.ai_turn_fail(uuid, uuid, integer, text, jsonb, uuid, bigint),
  public.ai_mutation_begin(uuid, uuid, integer, text, text, text, jsonb),
  public.ai_mutation_commit(uuid, uuid, jsonb, jsonb),
  public.ai_mutation_fail(uuid, uuid, text),
  public.ai_conversation_mutations(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.ai_turn_begin(uuid, text, text, integer, text),
  public.ai_turn_finish(uuid, uuid, integer, jsonb, uuid, jsonb, integer, integer, text, bigint, jsonb),
  public.ai_turn_fail(uuid, uuid, integer, text, jsonb, uuid, bigint),
  public.ai_mutation_begin(uuid, uuid, integer, text, text, text, jsonb),
  public.ai_mutation_commit(uuid, uuid, jsonb, jsonb),
  public.ai_mutation_fail(uuid, uuid, text),
  public.ai_conversation_mutations(uuid, uuid, bigint)
  to service_role;
