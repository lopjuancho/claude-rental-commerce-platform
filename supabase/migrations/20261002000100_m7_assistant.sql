-- M7 AI assistant (ADR 0017): anonymous, tenant-scoped conversations and tool telemetry.
--
-- Visitors never touch these tables. The server reaches them only through the narrow
-- service-role functions below (trusted gateway, ADR 0001 / hardening H5); staff may read their
-- own organization's rows (conversation viewer, M8). Nothing here grants any business capability:
-- every transactional action the assistant takes goes through the existing M3–M5 services.

create table public.ai_conversations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- SHA-256 of the opaque session cookie; the cookie value itself is never stored.
  session_hash     text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  channel          text not null default 'web' check (channel in ('web')),
  -- Validated working state (draft contact/event/items, current quote reference by token HASH).
  state            jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(state) = 'object' and pg_column_size(state) <= 32768),
  state_version    integer not null default 0,
  quote_id         uuid,
  message_count    integer not null default 0,
  tool_call_count  integer not null default 0,
  token_usage      integer not null default 0,
  prompt_version   text check (length(prompt_version) <= 40),
  last_message_at  timestamptz,
  -- Retention: configurable later (sweeper); an expired conversation is reset on next use.
  expires_at       timestamptz not null default now() + interval '30 days',
  created_at       timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, session_hash),
  foreign key (organization_id, quote_id) references public.quotes (organization_id, id) on delete set null (quote_id)
);

create table public.ai_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  conversation_id  uuid not null,
  seq              integer not null,
  role             text not null check (role in ('user', 'assistant', 'tool')),
  content          text check (length(content) <= 20000),
  -- Assistant tool calls (arguments with contact details redacted) or a tool result.
  structured       jsonb check (structured is null or pg_column_size(structured) <= 65536),
  created_at       timestamptz not null default now(),
  unique (conversation_id, seq),
  foreign key (organization_id, conversation_id)
    references public.ai_conversations (organization_id, id) on delete cascade
);

-- Troubleshooting telemetry: no arguments, no results, no customer data — just what ran and how.
create table public.ai_actions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  conversation_id  uuid not null,
  tool_name        text not null check (tool_name ~ '^[a-z_]{1,40}$'),
  status           text not null check (status in ('ok', 'manual_review', 'rejected_validation',
                                                   'rejected_policy', 'error', 'guardrail_violation')),
  error_code       text check (length(error_code) <= 60),
  duration_ms      integer check (duration_ms >= 0),
  correlation_id   text check (length(correlation_id) <= 80),
  model            text check (length(model) <= 80),
  created_at       timestamptz not null default now(),
  foreign key (organization_id, conversation_id)
    references public.ai_conversations (organization_id, id) on delete cascade
);
create index ai_actions_org_created_idx on public.ai_actions (organization_id, created_at desc);
create index ai_messages_conversation_idx on public.ai_messages (conversation_id, seq);

do $$
declare
  t text;
begin
  foreach t in array array['ai_conversations', 'ai_messages', 'ai_actions'] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.prevent_organization_change()', t || '_org_immutable', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format($p$create policy %I on public.%I for select to authenticated
                     using ((select app.has_permission(organization_id, 'org.read')))$p$, t || '_select', t);
  end loop;
end $$;

-- ───────────────────────────── service-role functions ─────────────────────────────

-- Opens (or creates) the conversation for this session in this organization. An expired
-- conversation is reset: its messages are deleted and its state cleared.
create function public.ai_conversation_open(p_organization_id uuid, p_session_hash text)
returns table (id uuid, state jsonb, state_version integer, message_count integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.ai_conversations;
begin
  perform app.require_service_role();
  if p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_REQUEST: session' using errcode = 'RA006';
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
  if c.expires_at <= now() then
    delete from public.ai_messages m where m.conversation_id = c.id;
    update public.ai_conversations a
       set state = '{}'::jsonb, state_version = a.state_version + 1, quote_id = null,
           message_count = 0, tool_call_count = 0, token_usage = 0,
           expires_at = now() + interval '30 days'
     where a.id = c.id
    returning * into c;
  end if;
  return query select c.id, c.state, c.state_version, c.message_count;
end;
$$;

-- The last p_limit messages, oldest first.
create function public.ai_conversation_history(p_organization_id uuid, p_conversation_id uuid, p_limit integer)
returns table (seq integer, role text, content text, structured jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_service_role();
  return query
  select m.seq, m.role, m.content, m.structured
  from (select x.seq, x.role, x.content, x.structured from public.ai_messages x
        where x.organization_id = p_organization_id and x.conversation_id = p_conversation_id
        order by x.seq desc
        limit least(greatest(p_limit, 1), 200)) m
  order by m.seq;
end;
$$;

-- Appends one turn atomically (optimistic concurrency on state_version) and returns the new
-- version. A concurrent turn in the same session fails with CONFLICT and can be retried.
create function public.ai_conversation_append(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_expected_version integer,
  p_state jsonb,
  p_quote_id uuid,
  p_messages jsonb,
  p_tool_calls integer,
  p_tokens integer,
  p_prompt_version text
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
  select * into c from public.ai_conversations a
  where a.organization_id = p_organization_id and a.id = p_conversation_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if c.state_version <> p_expected_version then
    raise exception 'CONFLICT: conversation changed' using errcode = 'RA010';
  end if;
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
         message_count = a.message_count + jsonb_array_length(p_messages),
         tool_call_count = a.tool_call_count + greatest(p_tool_calls, 0),
         token_usage = a.token_usage + greatest(p_tokens, 0),
         prompt_version = p_prompt_version,
         last_message_at = now(),
         expires_at = greatest(a.expires_at, now() + interval '30 days')
   where a.id = c.id;
  return c.state_version + 1;
end;
$$;

create function public.ai_action_record(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_tool_name text,
  p_status text,
  p_error_code text,
  p_duration_ms integer,
  p_correlation_id text,
  p_model text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.require_service_role();
  insert into public.ai_actions (organization_id, conversation_id, tool_name, status, error_code,
                                 duration_ms, correlation_id, model)
  values (p_organization_id, p_conversation_id, p_tool_name, p_status, p_error_code,
          p_duration_ms, p_correlation_id, p_model);
end;
$$;

revoke execute on function public.ai_conversation_open(uuid, text),
  public.ai_conversation_history(uuid, uuid, integer),
  public.ai_conversation_append(uuid, uuid, integer, jsonb, uuid, jsonb, integer, integer, text),
  public.ai_action_record(uuid, uuid, text, text, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.ai_conversation_open(uuid, text),
  public.ai_conversation_history(uuid, uuid, integer),
  public.ai_conversation_append(uuid, uuid, integer, jsonb, uuid, jsonb, integer, integer, text),
  public.ai_action_record(uuid, uuid, text, text, text, integer, text, text)
  to service_role;
