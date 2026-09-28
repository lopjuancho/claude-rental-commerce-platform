-- Milestone 1 · Append-only audit log. Design: DATABASE.md §11.

create type public.audit_actor_type as enum ('user', 'ai', 'system', 'public');

create table public.audit_logs (
  id              bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_type      public.audit_actor_type not null,
  actor_user_id   uuid,
  ai_action_id    uuid,
  action          text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),  -- 'member.role_changed'
  entity_type     text not null check (length(entity_type) between 1 and 100),
  entity_id       text,
  changes         jsonb,        -- {"field": [old, new]} for trigger rows; free-form metadata otherwise
  ip_address      inet,
  user_agent      text check (length(user_agent) <= 500),
  request_id      text check (length(request_id) <= 100),
  created_at      timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (organization_id, entity_type, entity_id);

-- Append-only, for every role (including service_role and table owner via this trigger).
create function app.audit_logs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Allow rows to disappear only via organization deletion cascade.
  if tg_op = 'DELETE' and old.organization_id is not null
     and not exists (select 1 from public.organizations where id = old.organization_id) then
    return old;
  end if;
  raise exception 'audit_logs is append-only' using errcode = 'insufficient_privilege';
end;
$$;
create trigger audit_logs_no_update before update on public.audit_logs
  for each row execute function app.audit_logs_immutable();
create trigger audit_logs_no_delete before delete on public.audit_logs
  for each row execute function app.audit_logs_immutable();

alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;

revoke all on public.audit_logs from anon, authenticated;
revoke update, delete, truncate on public.audit_logs from service_role;
grant select on public.audit_logs to authenticated;

create policy audit_logs_select on public.audit_logs for select to authenticated
  using ((select app.has_permission(organization_id, 'audit.read')));

-- ───────────── Trigger-based auditing for sensitive tables ─────────────
-- Records who changed what. Secret-bearing columns are never copied into the log.
create function app.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_org uuid;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_redacted text[] := array['token_hash'];
  v_entity_id text;
begin
  v_org := case when tg_table_name = 'organizations' then (v_row ->> 'id')::uuid
                else (v_row ->> 'organization_id')::uuid end;

  -- Skip rows of an organization that is being deleted (cascade).
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = v_org) then
    return old;
  end if;

  for v_key in select jsonb_object_keys(v_row) loop
    continue when v_key = any (v_redacted) or v_key in ('updated_at', 'created_at');
    if tg_op = 'UPDATE' then
      if (v_old -> v_key) is distinct from (v_new -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_array(v_old -> v_key, v_new -> v_key));
      end if;
    elsif tg_op = 'INSERT' then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_array(null, v_new -> v_key));
    else
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_array(v_old -> v_key, null));
    end if;
  end loop;

  if tg_op = 'UPDATE' and v_changes = '{}'::jsonb then
    return new;
  end if;

  v_entity_id := coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'organization_id');

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, changes)
  values (
    v_org,
    case when (select auth.uid()) is null then 'system' else 'user' end::public.audit_actor_type,
    (select auth.uid()),
    tg_argv[0] || '.' || lower(case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end),
    tg_table_name,
    v_entity_id,
    v_changes
  );

  return coalesce(new, old);
end;
$$;
revoke execute on function app.audit_row_change(), app.audit_logs_immutable() from public;

create trigger audit_organizations after update on public.organizations
  for each row execute function app.audit_row_change('organization');
create trigger audit_organization_settings after update on public.organization_settings
  for each row execute function app.audit_row_change('settings');
create trigger audit_organization_policies after insert or update or delete on public.organization_policies
  for each row execute function app.audit_row_change('policy');
create trigger audit_organization_members after insert or update or delete on public.organization_members
  for each row execute function app.audit_row_change('member');
create trigger audit_organization_invitations after insert or update or delete on public.organization_invitations
  for each row execute function app.audit_row_change('invitation');
create trigger audit_organization_domains after insert or update or delete on public.organization_domains
  for each row execute function app.audit_row_change('domain');

-- ───────────── Semantic audit events from the user context ─────────────
-- For actions that are not a single row change ("quote.sent", "import.committed").
-- The actor is always the caller; callers can only write into organizations they belong to.
create function public.record_audit_event(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text default null,
  p_metadata jsonb default null,
  p_request_id text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if (select auth.uid()) is null or not app.is_member(p_organization_id) then
    raise exception 'not a member of this organization' using errcode = 'insufficient_privilege';
  end if;
  if p_metadata is not null and pg_column_size(p_metadata) > 16384 then
    raise exception 'audit metadata too large' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, changes, request_id)
  values (p_organization_id, 'user', (select auth.uid()), p_action, p_entity_type, p_entity_id, p_metadata, p_request_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.record_audit_event(uuid, text, text, text, jsonb, text) from public, anon;
grant execute on function public.record_audit_event(uuid, text, text, text, jsonb, text) to authenticated;
