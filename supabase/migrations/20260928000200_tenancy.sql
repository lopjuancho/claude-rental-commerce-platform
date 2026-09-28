-- Milestone 1 · Tenancy, identity and access control.
-- Design: DATABASE.md §3 and §12. RLS is the primary tenant boundary.

-- ───────────────────────────── Types ─────────────────────────────
create type public.org_status as enum ('onboarding', 'active', 'suspended', 'closed');
-- Adding roles later (driver, warehouse): `alter type org_role add value …` + role_permissions rows.
create type public.org_role as enum ('owner', 'admin', 'office', 'staff');
create type public.member_status as enum ('active', 'suspended');

-- ───────────────────────────── Tables ────────────────────────────
create table public.organizations (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique
               check (slug ~ '^[a-z0-9](-?[a-z0-9])*$' and length(slug) between 2 and 63),
  name         text not null check (length(btrim(name)) between 1 and 200),
  legal_name   text check (length(legal_name) <= 200),
  status       public.org_status not null default 'onboarding',
  timezone     text not null default 'America/Chicago',
  currency     char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  country_code char(2) not null default 'US' check (country_code ~ '^[A-Z]{2}$'),
  plan         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Reject time zones Postgres does not know (prevents silent UTC fallbacks later).
create function app.is_valid_timezone(p_tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz)
$$;
alter table public.organizations
  add constraint organizations_timezone_valid check (app.is_valid_timezone(timezone));

create table public.organization_domains (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  hostname        extensions.citext not null unique
                  check (hostname ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),  -- no scheme, no port
  is_primary      boolean not null default false,
  verified_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index organization_domains_org_idx on public.organization_domains (organization_id);
create unique index organization_domains_one_primary
  on public.organization_domains (organization_id) where is_primary;

create table public.organization_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  -- branding
  logo_media_path text,
  primary_color   text check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  secondary_color text check (secondary_color ~ '^#[0-9a-fA-F]{6}$'),
  -- contact
  contact_phone   text,
  sms_phone       text,
  contact_email   extensions.citext,
  website_url     text check (website_url ~ '^https?://'),
  address_line1   text,
  city            text,
  state           text,
  postal_code     text,
  -- operational defaults: the "organization" level of the override chain (ADR 0003)
  default_setup_buffer_minutes    integer not null default 60 check (default_setup_buffer_minutes between 0 and 1440),
  default_teardown_buffer_minutes integer not null default 60 check (default_teardown_buffer_minutes between 0 and 1440),
  default_event_start_time        time not null default '10:00',
  default_rental_duration_minutes integer not null default 360 check (default_rental_duration_minutes > 0),
  min_booking_lead_time_minutes   integer not null default 720 check (min_booking_lead_time_minutes >= 0),
  overnight_allowed               boolean not null default false,
  max_wind_mph                    smallint check (max_wind_mph > 0),
  quote_valid_days                integer not null default 7 check (quote_valid_days between 1 and 365),
  booking_hold_minutes            integer not null default 15 check (booking_hold_minutes between 1 and 1440),
  -- delivery origin for mileage-based delivery (decision D15 pending)
  depot_address_line1 text,
  depot_city          text,
  depot_state         text,
  depot_postal_code   text,
  depot_latitude      numeric(9, 6) check (depot_latitude between -90 and 90),
  depot_longitude     numeric(9, 6) check (depot_longitude between -180 and 180),
  -- assistant
  assistant_enabled      boolean not null default false,
  assistant_display_name text,
  assistant_greeting     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_policies (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  policy_type     text not null
                  check (policy_type in ('cancellation', 'weather', 'deposit', 'delivery', 'safety', 'other')),
  title           text not null check (length(title) between 1 and 200),
  body            text not null check (length(body) between 1 and 20000),
  version         integer not null default 1 check (version > 0),
  is_published    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);
create index organization_policies_org_idx on public.organization_policies (organization_id);

create table public.user_profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text check (length(full_name) <= 200),
  phone       text,
  avatar_path text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            public.org_role not null,
  status          public.member_status not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

create table public.organization_invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email           extensions.citext not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role            public.org_role not null,
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),  -- sha256 hex; raw token never stored
  invited_by      uuid references auth.users (id) on delete set null,
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  accepted_by     uuid references auth.users (id) on delete set null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  check (expires_at > created_at)
);
create index organization_invitations_org_idx on public.organization_invitations (organization_id);

-- Global role → permission map. Authorization checks permissions, never role names.
create table public.role_permissions (
  role       public.org_role not null,
  permission text not null check (permission ~ '^[a-z_]+\.[a-z_]+$'),
  primary key (role, permission)
);

insert into public.role_permissions (role, permission)
select r::public.org_role, p
from (values
  ('owner',  array['org.read','catalog.write','availability.write','customers.read','customers.write',
                   'events.write','quotes.write','conversations.read','pricing.write','settings.write',
                   'members.manage','members.grant_owner','audit.read','org.delete']),
  ('admin',  array['org.read','catalog.write','availability.write','customers.read','customers.write',
                   'events.write','quotes.write','conversations.read','pricing.write','settings.write',
                   'members.manage','audit.read']),
  ('office', array['org.read','catalog.write','availability.write','customers.read','customers.write',
                   'events.write','quotes.write','conversations.read']),
  ('staff',  array['org.read','customers.read'])
) as m(r, perms), unnest(perms) as p;

-- ─────────────────────── Authorization helpers ───────────────────────
-- SECURITY DEFINER so policies can consult membership without recursive RLS.
-- Policies call them as `(select app.fn(...))` so they are evaluated once per statement.

create function app.is_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and o.status <> 'closed'
  )
$$;

create function app.has_permission(p_organization_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    join public.role_permissions rp on rp.role = m.role
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and o.status <> 'closed'
      and rp.permission = p_permission
  )
$$;

-- Organizations the current user can act in (used by policies on user-scoped tables).
create function app.user_organization_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = (select auth.uid()) and m.status = 'active'
$$;

revoke execute on function app.is_member(uuid), app.has_permission(uuid, text),
  app.user_organization_ids(), app.is_valid_timezone(text) from public;
grant execute on function app.is_member(uuid), app.has_permission(uuid, text),
  app.user_organization_ids(), app.is_valid_timezone(text) to anon, authenticated, service_role;

-- ───────────────────────────── Triggers ─────────────────────────────
create trigger organizations_updated_at before update on public.organizations
  for each row execute function app.set_updated_at();
create trigger organization_settings_updated_at before update on public.organization_settings
  for each row execute function app.set_updated_at();
create trigger organization_policies_updated_at before update on public.organization_policies
  for each row execute function app.set_updated_at();
create trigger user_profiles_updated_at before update on public.user_profiles
  for each row execute function app.set_updated_at();
create trigger organization_members_updated_at before update on public.organization_members
  for each row execute function app.set_updated_at();

create trigger organization_domains_org_immutable before update on public.organization_domains
  for each row execute function app.prevent_organization_change();
create trigger organization_settings_org_immutable before update on public.organization_settings
  for each row execute function app.prevent_organization_change();
create trigger organization_policies_org_immutable before update on public.organization_policies
  for each row execute function app.prevent_organization_change();
create trigger organization_members_org_immutable before update on public.organization_members
  for each row execute function app.prevent_organization_change();
create trigger organization_invitations_org_immutable before update on public.organization_invitations
  for each row execute function app.prevent_organization_change();

-- Every organization gets its settings row.
create function app.on_organization_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_settings (organization_id) values (new.id);
  return new;
end;
$$;
create trigger organizations_create_settings after insert on public.organizations
  for each row execute function app.on_organization_created();

-- Every auth user gets a profile.
create function app.on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.on_auth_user_created();

-- Membership integrity: user_id is immutable, owners are only managed by owners,
-- and an organization can never lose its last active owner.
create function app.guard_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
  v_actor uuid := (select auth.uid());
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'user_id is immutable' using errcode = 'check_violation';
  end if;

  -- Organization being deleted: its memberships cascade away with it.
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.organization_id) then
    return old;
  end if;

  -- Owner rule applies to API users changing existing memberships. Inserts only happen through
  -- accept_invitation() (owner invitations are already restricted at invite time) or service_role.
  if v_actor is not null
     and tg_op in ('UPDATE', 'DELETE')
     and (old.role = 'owner' or (tg_op = 'UPDATE' and new.role = 'owner'))
     and not app.has_permission(v_org, 'members.grant_owner') then
    raise exception 'only an owner can grant, change or remove the owner role'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active')
     and not exists (
       select 1 from public.organization_members m
       where m.organization_id = v_org and m.role = 'owner' and m.status = 'active'
         and m.user_id <> old.user_id
     ) then
    raise exception 'an organization must keep at least one active owner'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;
create trigger organization_members_guard
  before insert or update or delete on public.organization_members
  for each row execute function app.guard_membership_change();

-- Invitations: only owners may invite owners.
create function app.guard_invitation_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and new.role = 'owner'
     and not app.has_permission(new.organization_id, 'members.grant_owner') then
    raise exception 'only an owner can invite an owner' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger organization_invitations_guard
  before insert or update on public.organization_invitations
  for each row execute function app.guard_invitation_change();

revoke execute on function app.on_organization_created(), app.on_auth_user_created(),
  app.guard_membership_change(), app.guard_invitation_change() from public;

-- ───────────────────────────── RLS ─────────────────────────────
alter table public.organizations            enable row level security;
alter table public.organization_domains     enable row level security;
alter table public.organization_settings    enable row level security;
alter table public.organization_policies    enable row level security;
alter table public.user_profiles            enable row level security;
alter table public.organization_members     enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.role_permissions         enable row level security;

alter table public.organizations            force row level security;
alter table public.organization_domains     force row level security;
alter table public.organization_settings    force row level security;
alter table public.organization_policies    force row level security;
alter table public.user_profiles            force row level security;
alter table public.organization_members     force row level security;
alter table public.organization_invitations force row level security;
alter table public.role_permissions         force row level security;

-- Defense in depth: anonymous visitors get no direct table access at all (ADR 0001).
-- Public reads go through narrow SECURITY DEFINER functions (below) and, from M2, catalog views.
revoke all on public.organizations, public.organization_domains, public.organization_settings,
  public.organization_policies, public.user_profiles, public.organization_members,
  public.organization_invitations, public.role_permissions from anon;

-- organizations: members read; settings.write may edit descriptive columns only.
-- status/plan/slug are platform-controlled (service_role).
revoke insert, update, delete on public.organizations from authenticated;
grant update (name, legal_name, timezone) on public.organizations to authenticated;

create policy organizations_select on public.organizations for select to authenticated
  using ((select app.is_member(id)));
create policy organizations_update on public.organizations for update to authenticated
  using ((select app.has_permission(id, 'settings.write')))
  with check ((select app.has_permission(id, 'settings.write')));

-- organization_domains: members read; writes are platform-only (domain verification / TLS).
revoke insert, update, delete on public.organization_domains from authenticated;
create policy organization_domains_select on public.organization_domains for select to authenticated
  using ((select app.has_permission(organization_id, 'org.read')));

-- organization_settings: created by trigger; members read; settings.write updates.
revoke insert, delete on public.organization_settings from authenticated;
create policy organization_settings_select on public.organization_settings for select to authenticated
  using ((select app.has_permission(organization_id, 'org.read')));
create policy organization_settings_update on public.organization_settings for update to authenticated
  using ((select app.has_permission(organization_id, 'settings.write')))
  with check ((select app.has_permission(organization_id, 'settings.write')));

-- organization_policies
create policy organization_policies_select on public.organization_policies for select to authenticated
  using ((select app.has_permission(organization_id, 'org.read')));
create policy organization_policies_insert on public.organization_policies for insert to authenticated
  with check ((select app.has_permission(organization_id, 'settings.write')));
create policy organization_policies_update on public.organization_policies for update to authenticated
  using ((select app.has_permission(organization_id, 'settings.write')))
  with check ((select app.has_permission(organization_id, 'settings.write')));
create policy organization_policies_delete on public.organization_policies for delete to authenticated
  using ((select app.has_permission(organization_id, 'settings.write')));

-- user_profiles: own profile read/update; co-members can read names.
revoke insert, delete on public.user_profiles from authenticated;
create policy user_profiles_select on public.user_profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.organization_members m
      where m.user_id = user_profiles.id
        and m.organization_id in (select app.user_organization_ids())
    )
  );
create policy user_profiles_update on public.user_profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- organization_members: members see co-members; members.manage changes roles/status/removes.
-- New members are only added through accept_invitation() (no INSERT policy).
revoke insert on public.organization_members from authenticated;
revoke update on public.organization_members from authenticated;
grant update (role, status) on public.organization_members to authenticated;
create policy organization_members_select on public.organization_members for select to authenticated
  using (user_id = (select auth.uid()) or (select app.has_permission(organization_id, 'org.read')));
create policy organization_members_update on public.organization_members for update to authenticated
  using ((select app.has_permission(organization_id, 'members.manage')))
  with check ((select app.has_permission(organization_id, 'members.manage')));
create policy organization_members_delete on public.organization_members for delete to authenticated
  using ((select app.has_permission(organization_id, 'members.manage')));

-- organization_invitations: members.manage only. Tokens are stored hashed.
revoke update on public.organization_invitations from authenticated;
grant update (revoked_at) on public.organization_invitations to authenticated;
create policy organization_invitations_select on public.organization_invitations for select to authenticated
  using ((select app.has_permission(organization_id, 'members.manage')));
create policy organization_invitations_insert on public.organization_invitations for insert to authenticated
  with check (
    (select app.has_permission(organization_id, 'members.manage'))
    and invited_by = (select auth.uid())
    and accepted_at is null and accepted_by is null and revoked_at is null
  );
create policy organization_invitations_update on public.organization_invitations for update to authenticated
  using ((select app.has_permission(organization_id, 'members.manage')) and accepted_at is null)
  with check ((select app.has_permission(organization_id, 'members.manage')));
create policy organization_invitations_delete on public.organization_invitations for delete to authenticated
  using ((select app.has_permission(organization_id, 'members.manage')));

-- role_permissions: readable reference data; never writable through the API.
revoke insert, update, delete on public.role_permissions from authenticated;
create policy role_permissions_select on public.role_permissions for select to authenticated
  using (true);

-- ─────────────────────── API functions ───────────────────────

-- Public tenant resolution (host → organization) for the storefront. Returns only public,
-- non-sensitive fields and only for active organizations.
create function public.resolve_organization_by_host(p_host text)
returns table (
  id uuid,
  slug text,
  name text,
  timezone text,
  currency char(3),
  logo_media_path text,
  primary_color text,
  secondary_color text,
  contact_phone text,
  contact_email text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.slug, o.name, o.timezone, o.currency,
         s.logo_media_path, s.primary_color, s.secondary_color, s.contact_phone, s.contact_email::text
  from public.organization_domains d
  join public.organizations o on o.id = d.organization_id
  join public.organization_settings s on s.organization_id = o.id
  where d.hostname = lower(p_host)::extensions.citext
    and o.status = 'active'
  limit 1
$$;

-- Development-only fallback resolution by slug. The app only calls this when not in production.
create function public.resolve_organization_by_slug(p_slug text)
returns table (
  id uuid,
  slug text,
  name text,
  timezone text,
  currency char(3),
  logo_media_path text,
  primary_color text,
  secondary_color text,
  contact_phone text,
  contact_email text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.slug, o.name, o.timezone, o.currency,
         s.logo_media_path, s.primary_color, s.secondary_color, s.contact_phone, s.contact_email::text
  from public.organizations o
  join public.organization_settings s on s.organization_id = o.id
  where o.slug = lower(p_slug) and o.status = 'active'
  limit 1
$$;

-- Accept an invitation with the raw token. The invitation email must match the signed-in
-- user's verified email. Single use; expired or revoked invitations are rejected.
create function public.accept_invitation(p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_email text := lower((select auth.jwt()) ->> 'email');
  v_inv public.organization_invitations;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if p_token is null or length(p_token) < 32 then
    raise exception 'invalid invitation' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_inv
  from public.organization_invitations
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;

  if not found
     or v_inv.accepted_at is not null
     or v_inv.revoked_at is not null
     or v_inv.expires_at <= now()
     or v_email is null
     or lower(v_inv.email::text) <> v_email then
    -- One error for every failure mode: don't reveal which check failed.
    raise exception 'invalid invitation' using errcode = 'invalid_parameter_value';
  end if;

  if exists (select 1 from public.organization_members
             where organization_id = v_inv.organization_id and user_id = v_user) then
    raise exception 'already a member' using errcode = 'unique_violation';
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_inv.organization_id, v_user, v_inv.role);

  update public.organization_invitations
  set accepted_at = now(), accepted_by = v_user
  where id = v_inv.id;

  return v_inv.organization_id;
end;
$$;

-- Platform-level organization creation (service_role only: onboarding scripts, tenant import).
create function public.create_organization(
  p_slug text, p_name text, p_timezone text, p_owner_user_id uuid, p_legal_name text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  insert into public.organizations (slug, name, legal_name, timezone)
  values (p_slug, p_name, p_legal_name, p_timezone)
  returning id into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, p_owner_user_id, 'owner');

  return v_org;
end;
$$;

revoke execute on function public.resolve_organization_by_host(text),
  public.resolve_organization_by_slug(text),
  public.accept_invitation(text),
  public.create_organization(text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_organization_by_host(text),
  public.resolve_organization_by_slug(text) to anon, authenticated, service_role;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.create_organization(text, text, text, uuid, text) to service_role;
