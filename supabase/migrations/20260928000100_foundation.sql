-- Milestone 1 · Foundation: extensions, private helper schema, shared trigger functions.
-- Conventions: DATABASE.md §1. Every function sets search_path = '' and fully qualifies names.

create extension if not exists pgcrypto  with schema extensions;
create extension if not exists citext    with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_trgm   with schema extensions;

-- Helper schema. Not exposed through PostgREST (not in the API's exposed schemas).
create schema if not exists app;
revoke all on schema app from public;
-- RLS policies evaluate helper functions as the calling role, so API roles need USAGE.
grant usage on schema app to anon, authenticated, service_role;

-- Keep updated_at current on every mutable table.
create function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- A row can never be moved to a different tenant.
create function app.prevent_organization_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on all functions in schema app from public;
