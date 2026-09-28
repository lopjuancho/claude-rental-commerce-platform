-- Milestone 3 · Availability engine: blocks, reservations, allocations, holds, weather blocks, flags.
-- Design: ARCHITECTURE.md §7.2, DATABASE.md §5–6, ADR 0002 (holds), ADR 0003 (buffers), ADR 0010 (weather).
--
-- Guarantees (all enforced in the database, never in the UI):
--  * A serialized unit can never be allocated twice for overlapping occupied periods
--    (exclusion constraint), whatever the concurrency.
--  * Pooled stock is serialized per variant with a transaction-scoped advisory lock and checked
--    against PEAK concurrent use, so the last items cannot be sold twice.
--  * Expired holds never block anything: reads ignore them and writers release them first.
--  * Blocks and weather flag existing bookings for staff; nothing is cancelled automatically.
--
-- Errors use SQLSTATE class "RA" so the application can map them without parsing text:
--   RA001 INSUFFICIENT_AVAILABILITY  RA002 BLOCKED (blackout / product block / weather)
--   RA003 OUTSIDE_LEAD_TIME          RA004 HOLD_EXPIRED
--   RA005 NOT_FOUND (incl. other tenants' data)   RA006 INVALID_REQUEST / INVALID_STATE
--   RA007 HOLD_RENEWAL_LIMIT

create type public.block_reason as enum ('blackout', 'maintenance', 'repair', 'private_use', 'staff_hold', 'other');
create type public.reservation_status as enum ('held', 'confirmed', 'released', 'cancelled', 'completed');
create type public.reservation_source as enum ('booking_request', 'manual', 'import');
create type public.weather_block_status as enum ('proposed', 'confirmed', 'lifted');
create type public.weather_block_scope as enum ('all_sensitive', 'selected');
create type public.reservation_flag_kind as enum ('availability_block', 'weather_block');

alter table public.organization_settings
  add column max_hold_renewals integer not null default 3 check (max_hold_renewals between 0 and 20),
  add column max_rental_days integer not null default 14 check (max_rental_days between 1 and 365);

-- ───────────────────────────── availability blocks ─────────────────────────────
create table public.availability_blocks (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  -- scope: none = whole organization (blackout); otherwise exactly one of these
  product_id        uuid,
  variant_id        uuid,
  inventory_unit_id uuid,
  period            tstzrange not null check (not isempty(period) and not lower_inf(period) and not upper_inf(period)),
  reason            public.block_reason not null,
  -- Partial block of POOLED stock only (e.g. 20 chairs out for repair). Null = everything in scope.
  quantity          integer check (quantity > 0),
  notes             text check (length(notes) <= 1000),
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id),
  check (num_nonnulls(product_id, variant_id, inventory_unit_id) <= 1),
  check (quantity is null or variant_id is not null),
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade,
  foreign key (organization_id, variant_id) references public.product_variants (organization_id, id) on delete cascade,
  foreign key (organization_id, inventory_unit_id) references public.inventory_units (organization_id, id) on delete cascade
);
create index availability_blocks_period_idx on public.availability_blocks using gist (organization_id, period);

-- ───────────────────────────── reservations ─────────────────────────────
create table public.reservations (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  source              public.reservation_source not null,
  status              public.reservation_status not null,
  hold_expires_at     timestamptz,
  hold_renewals       integer not null default 0 check (hold_renewals >= 0),
  replaced_by         uuid,
  -- Links to quotes/events/booking requests are added with those tables (M5).
  booking_request_id  uuid,
  quote_id            uuid,
  event_id            uuid,
  notes               text check (length(notes) <= 2000),
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  confirmed_at        timestamptz,
  ended_at            timestamptz,
  unique (organization_id, id),
  check (status <> 'held' or hold_expires_at is not null)
);
create index reservations_org_status_idx on public.reservations (organization_id, status);

create table public.reservation_allocations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  reservation_id    uuid not null,
  variant_id        uuid not null,
  inventory_unit_id uuid,
  quantity          integer not null default 1 check (quantity > 0),
  rental_period     tstzrange not null check (not isempty(rental_period)),
  occupied_period   tstzrange not null,
  -- Copied from the reservation header by trigger: an exclusion constraint's predicate can only
  -- see columns of its own row.
  status            public.reservation_status not null,
  hold_expires_at   timestamptz,
  created_at        timestamptz not null default now(),
  foreign key (organization_id, reservation_id) references public.reservations (organization_id, id) on delete cascade,
  foreign key (organization_id, variant_id) references public.product_variants (organization_id, id),
  foreign key (organization_id, inventory_unit_id) references public.inventory_units (organization_id, id),
  check (inventory_unit_id is null or quantity = 1),
  check (occupied_period @> rental_period),
  constraint reservation_allocations_no_unit_double_booking exclude using gist (
    inventory_unit_id with =,
    occupied_period with &&
  ) where (inventory_unit_id is not null and status in ('held', 'confirmed'))
);
create index reservation_allocations_active_idx on public.reservation_allocations
  using gist (variant_id, occupied_period) where (status in ('held', 'confirmed'));
create index reservation_allocations_reservation_idx on public.reservation_allocations (reservation_id);

-- ───────────────────────────── weather blocks ─────────────────────────────
create table public.weather_blocks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  hazard          public.weather_hazard not null,
  period          tstzrange not null check (not isempty(period) and not lower_inf(period) and not upper_inf(period)),
  status          public.weather_block_status not null default 'proposed',
  source          text not null default 'staff' check (source in ('staff', 'weather_api')),
  scope           public.weather_block_scope not null default 'all_sensitive',
  reason          text not null check (length(btrim(reason)) between 1 and 500),
  observed_value  numeric(6, 2) check (observed_value >= 0),
  observed_unit   text check (observed_unit in ('mph', 'kph', 'fahrenheit', 'celsius', 'inches_per_hour')),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  confirmed_by    uuid references auth.users (id) on delete set null,
  confirmed_at    timestamptz,
  lifted_by       uuid references auth.users (id) on delete set null,
  lifted_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  check ((observed_value is null) = (observed_unit is null))
);
create index weather_blocks_period_idx on public.weather_blocks using gist (organization_id, period) where (status = 'confirmed');

create table public.weather_block_targets (
  organization_id  uuid not null,
  weather_block_id uuid not null,
  category_id      uuid,
  product_id       uuid,
  check (num_nonnulls(category_id, product_id) = 1),
  unique nulls not distinct (weather_block_id, category_id, product_id),
  foreign key (organization_id, weather_block_id) references public.weather_blocks (organization_id, id) on delete cascade,
  foreign key (organization_id, category_id) references public.categories (organization_id, id) on delete cascade,
  foreign key (organization_id, product_id) references public.products (organization_id, id) on delete cascade
);

-- ───────────────────────────── reservation flags ─────────────────────────────
create table public.reservation_flags (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  reservation_id        uuid not null,
  kind                  public.reservation_flag_kind not null,
  availability_block_id uuid,
  weather_block_id      uuid,
  message               text not null,
  status                text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by           uuid references auth.users (id) on delete set null,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  unique nulls not distinct (reservation_id, availability_block_id, weather_block_id),
  check ((kind = 'availability_block') = (availability_block_id is not null)),
  check ((kind = 'weather_block') = (weather_block_id is not null)),
  foreign key (organization_id, reservation_id) references public.reservations (organization_id, id) on delete cascade,
  foreign key (organization_id, availability_block_id) references public.availability_blocks (organization_id, id) on delete cascade,
  foreign key (organization_id, weather_block_id) references public.weather_blocks (organization_id, id) on delete cascade
);
create index reservation_flags_open_idx on public.reservation_flags (organization_id) where (status = 'open');

-- ───────────────────────────── helpers ─────────────────────────────

-- Active = consumes inventory right now. Expired holds are NOT active.
create function app.allocation_is_active(p_status public.reservation_status, p_hold_expires_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_status = 'confirmed' or (p_status = 'held' and p_hold_expires_at > now())
$$;

-- Everything the engine needs to know about one variant, with ADR 0003 buffers resolved.
create function app.variant_context(p_variant_id uuid)
returns table (
  organization_id uuid, product_id uuid, primary_category_id uuid, tracking_mode public.tracking_mode,
  pooled_quantity integer, variant_active boolean, product_archived boolean, product_published boolean,
  organization_status public.org_status, setup_buffer_minutes integer, teardown_buffer_minutes integer,
  lead_time_minutes integer, booking_hold_minutes integer, max_rental_days integer, timezone text
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.organization_id, p.id, p.primary_category_id, v.tracking_mode, v.pooled_quantity,
         v.is_active and v.archived_at is null, p.archived_at is not null, p.is_published, o.status,
         coalesce(v.setup_buffer_minutes, p.setup_buffer_minutes, c.setup_buffer_minutes, s.default_setup_buffer_minutes),
         coalesce(v.teardown_buffer_minutes, p.teardown_buffer_minutes, c.teardown_buffer_minutes, s.default_teardown_buffer_minutes),
         coalesce(p.min_booking_lead_time_minutes, s.min_booking_lead_time_minutes),
         s.booking_hold_minutes, s.max_rental_days, o.timezone
  from public.product_variants v
  join public.products p on p.id = v.product_id
  join public.organizations o on o.id = v.organization_id
  join public.organization_settings s on s.organization_id = v.organization_id
  left join public.categories c on c.id = p.primary_category_id
  where v.id = p_variant_id
$$;

-- Confirmed weather blocks overlapping the rental period that apply to the product (ADR 0010).
create function app.blocking_weather(p_product_id uuid, p_period tstzrange)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id
  from public.weather_blocks w
  join public.products p on p.id = p_product_id and p.organization_id = w.organization_id
  where w.status = 'confirmed'
    and w.period && p_period
    and (
      (w.scope = 'selected' and exists (
        select 1 from public.weather_block_targets t
        where t.weather_block_id = w.id
          and (t.product_id = p.id
               or t.category_id in (select pc.category_id from public.product_categories pc where pc.product_id = p.id)
               or t.category_id = p.primary_category_id)
      ))
      or (w.scope = 'all_sensitive' and exists (
        select 1 from app.product_hazard_rules(p.id) r
        where r.hazard = w.hazard and r.sensitive
          and (w.observed_value is null or r.threshold_value is null
               or r.threshold_unit is distinct from w.observed_unit
               or w.observed_value >= r.threshold_value)
      ))
    )
$$;

-- Peak concurrent quantity of `intervals` within `window` (sweep line; ends sort before starts at
-- the same instant, so half-open back-to-back intervals do not overlap). Mirrors
-- src/domain/availability/capacity.ts.
create function app.peak_usage(p_window tstzrange, p_intervals tstzrange[], p_quantities integer[])
returns integer
language sql
immutable
set search_path = ''
as $$
  with iv as (
    select p_window * i.r as r, i.q
    from unnest(p_intervals, p_quantities) as i(r, q)
    where i.r && p_window
  ),
  ev as (
    select lower(r) as t, q as d from iv
    union all
    select upper(r) as t, -q as d from iv
  ),
  running as (
    select sum(d) over (order by t, d rows between unbounded preceding and current row) as level from ev
  )
  select coalesce(max(level), 0)::integer from running
$$;

-- Read-only availability of one variant for one rental period (no locks, no writes).
create function app.variant_availability(p_variant_id uuid, p_rental tstzrange)
returns table (capacity integer, available_quantity integer, reasons text[], occupied tstzrange)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ctx record;
  occ tstzrange;
  why text[] := '{}';
  cap integer;
  free integer;
  usage integer;
begin
  select * into ctx from app.variant_context(p_variant_id);
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;

  occ := tstzrange(lower(p_rental) - make_interval(mins => ctx.setup_buffer_minutes),
                   upper(p_rental) + make_interval(mins => ctx.teardown_buffer_minutes), '[)');

  if not ctx.variant_active or ctx.product_archived then
    why := array_append(why, 'VARIANT_INACTIVE');
  end if;
  if exists (select 1 from public.availability_blocks b
             where b.organization_id = ctx.organization_id and b.period && occ
               and b.product_id is null and b.variant_id is null and b.inventory_unit_id is null) then
    why := array_append(why, 'BLACKOUT');
  end if;
  if exists (select 1 from public.availability_blocks b
             where b.period && occ and b.quantity is null
               and (b.product_id = ctx.product_id or b.variant_id = p_variant_id)) then
    why := array_append(why, 'PRODUCT_BLOCKED');
  end if;
  if exists (select 1 from app.blocking_weather(ctx.product_id, p_rental)) then
    why := array_append(why, 'WEATHER_BLOCK');
  end if;

  if ctx.tracking_mode = 'serialized' then
    select count(*) into cap from public.inventory_units u where u.variant_id = p_variant_id and u.status = 'active';
    select count(*) into free
    from public.inventory_units u
    where u.variant_id = p_variant_id and u.status = 'active'
      and not exists (select 1 from public.availability_blocks b where b.inventory_unit_id = u.id and b.period && occ)
      and not exists (select 1 from public.reservation_allocations a
                      where a.inventory_unit_id = u.id and a.occupied_period && occ
                        and app.allocation_is_active(a.status, a.hold_expires_at));
  else
    cap := ctx.pooled_quantity;
    select app.peak_usage(occ, array_agg(x.r), array_agg(x.q)) into usage
    from (
      select a.occupied_period as r, a.quantity as q
      from public.reservation_allocations a
      where a.variant_id = p_variant_id and a.occupied_period && occ
        and app.allocation_is_active(a.status, a.hold_expires_at)
      union all
      select b.period, b.quantity
      from public.availability_blocks b
      where b.variant_id = p_variant_id and b.quantity is not null and b.period && occ
    ) x;
    free := greatest(cap - coalesce(usage, 0), 0);
  end if;

  if cardinality(why) > 0 then
    free := 0;
  end if;
  return query select cap, free, why, occ;
end;
$$;

-- Caller may act for the organization: staff with the permission, or the server's system context.
create function app.assert_can_act(p_organization_id uuid, p_permission text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) = 'service_role' then
    return 'system';
  end if;
  if (select auth.uid()) is not null and app.has_permission(p_organization_id, p_permission) then
    return 'staff';
  end if;
  -- Same error as a missing record: never reveal whether another tenant's data exists.
  raise exception 'NOT_FOUND' using errcode = 'RA005';
end;
$$;

create function app.parse_period(p_start text, p_end text)
returns tstzrange
language plpgsql
immutable
set search_path = ''
as $$
declare
  s timestamptz;
  e timestamptz;
begin
  begin
    s := p_start::timestamptz;
    e := p_end::timestamptz;
  exception when others then
    raise exception 'INVALID_REQUEST: bad timestamp' using errcode = 'RA006';
  end;
  if s is null or e is null or e <= s then
    raise exception 'INVALID_REQUEST: end must be after start' using errcode = 'RA006';
  end if;
  return tstzrange(s, e, '[)');
end;
$$;

-- Releases expired holds that touch the given variants (caller holds the variant locks).
create function app.release_expired_holds(p_variant_ids uuid[])
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update public.reservations r
    set status = 'released', ended_at = now()
    where r.status = 'held' and r.hold_expires_at <= now()
      and exists (select 1 from public.reservation_allocations a where a.reservation_id = r.id and a.variant_id = any (p_variant_ids))
    returning 1
  )
  select count(*)::integer from expired
$$;

-- ───────────────────────────── triggers ─────────────────────────────
create function app.sync_allocation_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status or new.hold_expires_at is distinct from old.hold_expires_at then
    update public.reservation_allocations
    set status = new.status, hold_expires_at = new.hold_expires_at
    where reservation_id = new.id;
  end if;
  return new;
end;
$$;
create trigger reservations_sync_allocations after update on public.reservations
  for each row execute function app.sync_allocation_status();

create function app.stamp_allocation_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select r.status, r.hold_expires_at into new.status, new.hold_expires_at
  from public.reservations r where r.id = new.reservation_id;
  return new;
end;
$$;
create trigger reservation_allocations_stamp before insert on public.reservation_allocations
  for each row execute function app.stamp_allocation_status();

-- Only pooled variants take partial (quantity) blocks.
create function app.availability_blocks_validate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.quantity is not null and
     (select v.tracking_mode from public.product_variants v where v.id = new.variant_id) <> 'pooled' then
    raise exception 'partial quantity blocks apply to pooled variants only; block individual units instead'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger availability_blocks_validate before insert or update on public.availability_blocks
  for each row execute function app.availability_blocks_validate();

-- A new or changed block flags overlapping active reservations for staff review (never cancels).
create function app.flag_reservations_for_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.reservation_flags (organization_id, reservation_id, kind, availability_block_id, message)
  select distinct a.organization_id, a.reservation_id, 'availability_block'::public.reservation_flag_kind, new.id,
         'Overlaps a ' || new.reason::text || ' block' || coalesce(': ' || new.notes, '')
  from public.reservation_allocations a
  join public.product_variants v on v.id = a.variant_id
  where a.organization_id = new.organization_id
    and a.occupied_period && new.period
    and app.allocation_is_active(a.status, a.hold_expires_at)
    and (
      (new.product_id is null and new.variant_id is null and new.inventory_unit_id is null)
      or new.product_id = v.product_id
      or new.variant_id = a.variant_id
      or new.inventory_unit_id = a.inventory_unit_id
    )
  on conflict do nothing;
  return new;
end;
$$;
create trigger availability_blocks_flag after insert or update of period, product_id, variant_id, inventory_unit_id
  on public.availability_blocks
  for each row execute function app.flag_reservations_for_block();

create trigger availability_blocks_updated_at before update on public.availability_blocks
  for each row execute function app.set_updated_at();
create trigger reservations_updated_at before update on public.reservations
  for each row execute function app.set_updated_at();
create trigger weather_blocks_updated_at before update on public.weather_blocks
  for each row execute function app.set_updated_at();
create trigger availability_blocks_org_immutable before update on public.availability_blocks
  for each row execute function app.prevent_organization_change();
create trigger reservations_org_immutable before update on public.reservations
  for each row execute function app.prevent_organization_change();
create trigger reservation_allocations_org_immutable before update on public.reservation_allocations
  for each row execute function app.prevent_organization_change();
create trigger weather_blocks_org_immutable before update on public.weather_blocks
  for each row execute function app.prevent_organization_change();
create trigger weather_block_targets_org_immutable before update on public.weather_block_targets
  for each row execute function app.prevent_organization_change();
create trigger reservation_flags_org_immutable before update on public.reservation_flags
  for each row execute function app.prevent_organization_change();

create trigger audit_availability_blocks after insert or update or delete on public.availability_blocks
  for each row execute function app.audit_row_change('availability_block');
create trigger audit_reservations after insert or update on public.reservations
  for each row execute function app.audit_row_change('reservation');
create trigger audit_weather_blocks after insert or update or delete on public.weather_blocks
  for each row execute function app.audit_row_change('weather_block');

-- ───────────────────────────── RLS ─────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['availability_blocks', 'reservations', 'reservation_allocations', 'weather_blocks',
                           'weather_block_targets', 'reservation_flags'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format($p$create policy %I on public.%I for select to authenticated
                     using ((select app.has_permission(organization_id, 'org.read')))$p$, t || '_select', t);
  end loop;
end $$;

-- Blocks: staff with availability.write manage them directly.
create policy availability_blocks_insert on public.availability_blocks for insert to authenticated
  with check ((select app.has_permission(organization_id, 'availability.write')) and created_by = (select auth.uid()));
create policy availability_blocks_update on public.availability_blocks for update to authenticated
  using ((select app.has_permission(organization_id, 'availability.write')))
  with check ((select app.has_permission(organization_id, 'availability.write')));
create policy availability_blocks_delete on public.availability_blocks for delete to authenticated
  using ((select app.has_permission(organization_id, 'availability.write')));

-- Reservations and allocations change ONLY through the functions below.
revoke insert, update, delete on public.reservations, public.reservation_allocations from authenticated;

-- Weather blocks: staff create/edit proposed blocks; confirming and lifting go through functions.
revoke update on public.weather_blocks from authenticated;
grant update (hazard, period, scope, reason, observed_value, observed_unit) on public.weather_blocks to authenticated;
create policy weather_blocks_insert on public.weather_blocks for insert to authenticated
  with check ((select app.has_permission(organization_id, 'availability.write'))
              and status = 'proposed' and created_by = (select auth.uid())
              and confirmed_by is null and lifted_by is null);
create policy weather_blocks_update on public.weather_blocks for update to authenticated
  using ((select app.has_permission(organization_id, 'availability.write')) and status = 'proposed')
  with check ((select app.has_permission(organization_id, 'availability.write')));
create policy weather_blocks_delete on public.weather_blocks for delete to authenticated
  using ((select app.has_permission(organization_id, 'availability.write')) and status = 'proposed');

revoke update on public.weather_block_targets from authenticated;
create policy weather_block_targets_insert on public.weather_block_targets for insert to authenticated
  with check ((select app.has_permission(organization_id, 'availability.write'))
              and exists (select 1 from public.weather_blocks w where w.id = weather_block_id and w.status = 'proposed'));
create policy weather_block_targets_delete on public.weather_block_targets for delete to authenticated
  using ((select app.has_permission(organization_id, 'availability.write'))
         and exists (select 1 from public.weather_blocks w where w.id = weather_block_id and w.status = 'proposed'));

-- Flags are created by triggers/functions; staff can only resolve them.
revoke insert, update, delete on public.reservation_flags from authenticated;
grant update (status, resolved_by, resolved_at) on public.reservation_flags to authenticated;
create policy reservation_flags_update on public.reservation_flags for update to authenticated
  using ((select app.has_permission(organization_id, 'availability.write')))
  with check ((select app.has_permission(organization_id, 'availability.write'))
              and (status = 'open' or resolved_by = (select auth.uid())));

-- ───────────────────────────── API: checks ─────────────────────────────

-- Staff / system availability check with exact quantities.
create function public.check_availability(
  p_organization_id uuid, p_variant_id uuid, p_start text, p_end text, p_quantity integer default 1,
  p_override_lead_time boolean default false
)
returns table (available boolean, available_quantity integer, capacity integer, requested_quantity integer,
               reasons text[], occupied_start timestamptz, occupied_end timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor text := app.assert_can_act(p_organization_id, 'org.read');
  rental tstzrange := app.parse_period(p_start, p_end);
  ctx record;
  snap record;
  why text[];
begin
  select * into ctx from app.variant_context(p_variant_id);
  if not found or ctx.organization_id <> p_organization_id then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 10000 then
    raise exception 'INVALID_REQUEST: quantity' using errcode = 'RA006';
  end if;
  select * into snap from app.variant_availability(p_variant_id, rental);
  why := snap.reasons;
  if lower(rental) < now() + make_interval(mins => ctx.lead_time_minutes)
     and not (p_override_lead_time and actor = 'staff' and app.has_permission(p_organization_id, 'availability.write')) then
    why := array_append(why, 'OUTSIDE_LEAD_TIME');
  end if;
  if upper(rental) - lower(rental) > make_interval(days => ctx.max_rental_days) then
    why := array_append(why, 'RENTAL_TOO_LONG');
  end if;
  if cardinality(why) = 0 and snap.available_quantity < p_quantity then
    why := array_append(why, 'INSUFFICIENT_QUANTITY');
  end if;
  return query select cardinality(why) = 0, snap.available_quantity, snap.capacity, p_quantity, why,
                      lower(snap.occupied), upper(snap.occupied);
end;
$$;

-- Public (storefront / assistant) check: no exact counts (decision D14), published products of
-- active organizations only, lead time always enforced.
create function public.check_public_availability(
  p_organization_id uuid, p_variant_id uuid, p_start text, p_end text, p_quantity integer default 1
)
returns table (available boolean, limited boolean, reasons text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rental tstzrange := app.parse_period(p_start, p_end);
  ctx record;
  snap record;
  why text[] := '{}';
begin
  select * into ctx from app.variant_context(p_variant_id);
  if not found or ctx.organization_id <> p_organization_id or ctx.organization_status <> 'active'
     or not ctx.product_published then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 1000 then
    raise exception 'INVALID_REQUEST: quantity' using errcode = 'RA006';
  end if;
  select * into snap from app.variant_availability(p_variant_id, rental);
  -- Internal block reasons are summarised; weather and blackout are safe to state publicly.
  if 'BLACKOUT' = any (snap.reasons) then why := array_append(why, 'BLACKOUT'); end if;
  if 'WEATHER_BLOCK' = any (snap.reasons) then why := array_append(why, 'WEATHER_BLOCK'); end if;
  if 'PRODUCT_BLOCKED' = any (snap.reasons) or 'VARIANT_INACTIVE' = any (snap.reasons) then why := array_append(why, 'UNAVAILABLE'); end if;
  if lower(rental) < now() + make_interval(mins => ctx.lead_time_minutes) then why := array_append(why, 'OUTSIDE_LEAD_TIME'); end if;
  if upper(rental) - lower(rental) > make_interval(days => ctx.max_rental_days) then why := array_append(why, 'RENTAL_TOO_LONG'); end if;
  if cardinality(why) = 0 and snap.available_quantity < p_quantity then why := array_append(why, 'INSUFFICIENT_QUANTITY'); end if;
  return query select cardinality(why) = 0,
                      cardinality(why) = 0 and snap.available_quantity - p_quantity <= 1,
                      why;
end;
$$;

-- ───────────────────────────── API: reservations ─────────────────────────────

/*
 * The ONLY way to consume inventory. p_items: [{"variant_id": uuid, "quantity": int,
 * "start": timestamptz, "end": timestamptz}, …] (1–50 items). All items succeed or none do.
 * p_replaces_reservation_id atomically swaps an existing hold (the old hold is released only if
 * the new reservation succeeds).
 */
create function public.reserve_inventory(
  p_organization_id uuid,
  p_items jsonb,
  p_status public.reservation_status default 'held',
  p_source public.reservation_source default 'booking_request',
  p_replaces_reservation_id uuid default null,
  p_override_lead_time boolean default false,
  p_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := app.assert_can_act(p_organization_id, 'availability.write');
  item jsonb;
  rental tstzrange;
  qty integer;
  vid uuid;
  ctx record;
  snap record;
  lock_ids uuid[];
  lid uuid;
  old public.reservations;
  rid uuid;
  hold_minutes integer;
  units uuid[];
begin
  if p_status not in ('held', 'confirmed') then
    raise exception 'INVALID_REQUEST: status must be held or confirmed' using errcode = 'RA006';
  end if;
  -- The server acting for the public may only create temporary holds (ADR 0002).
  if actor = 'system' and (p_status <> 'held' or p_override_lead_time) then
    raise exception 'INVALID_REQUEST: system context may only create holds' using errcode = 'RA006';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'INVALID_REQUEST: 1-50 items required' using errcode = 'RA006';
  end if;

  -- Validate ownership of every variant before taking any lock.
  for item in select * from jsonb_array_elements(p_items) loop
    vid := app.try_uuid(item ->> 'variant_id');
    select * into ctx from app.variant_context(vid);
    if vid is null or not found or ctx.organization_id <> p_organization_id then
      raise exception 'NOT_FOUND' using errcode = 'RA005';
    end if;
    lock_ids := lock_ids || vid;
  end loop;

  if p_replaces_reservation_id is not null then
    select * into old from public.reservations
    where id = p_replaces_reservation_id and organization_id = p_organization_id
    for update;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'RA005';
    end if;
    if old.status <> 'held' then
      raise exception 'INVALID_STATE: only a held reservation can be replaced' using errcode = 'RA006';
    end if;
    lock_ids := lock_ids || array(select distinct a.variant_id from public.reservation_allocations a where a.reservation_id = old.id);
  end if;

  -- Serialize writers per variant, always in the same order (no deadlocks).
  for lid in select distinct x from unnest(lock_ids) x order by x loop
    perform pg_advisory_xact_lock(hashtextextended('variant:' || lid::text, 0));
  end loop;

  perform app.release_expired_holds(lock_ids);
  if old.id is not null then
    update public.reservations set status = 'released', ended_at = now() where id = old.id;
  end if;

  select s.booking_hold_minutes into hold_minutes
  from public.organization_settings s where s.organization_id = p_organization_id;

  insert into public.reservations (organization_id, source, status, hold_expires_at, created_by, notes, confirmed_at)
  values (p_organization_id, p_source, p_status,
          case when p_status = 'held' then now() + make_interval(mins => hold_minutes) end,
          (select auth.uid()), left(p_notes, 2000),
          case when p_status = 'confirmed' then now() end)
  returning id into rid;

  for item in select * from jsonb_array_elements(p_items) loop
    vid := (item ->> 'variant_id')::uuid;
    rental := app.parse_period(item ->> 'start', item ->> 'end');
    qty := coalesce((item ->> 'quantity')::integer, 1);
    if qty < 1 or qty > 10000 then
      raise exception 'INVALID_REQUEST: quantity' using errcode = 'RA006';
    end if;

    select * into ctx from app.variant_context(vid);
    if upper(rental) - lower(rental) > make_interval(days => ctx.max_rental_days) then
      raise exception 'INVALID_REQUEST: rental longer than % days', ctx.max_rental_days using errcode = 'RA006';
    end if;
    if lower(rental) < now() + make_interval(mins => ctx.lead_time_minutes)
       and not (p_override_lead_time and actor = 'staff') then
      raise exception 'OUTSIDE_LEAD_TIME' using errcode = 'RA003';
    end if;
    if actor = 'system' and (not ctx.product_published or ctx.organization_status <> 'active') then
      raise exception 'NOT_FOUND' using errcode = 'RA005';
    end if;

    select * into snap from app.variant_availability(vid, rental);
    if cardinality(snap.reasons) > 0 then
      raise exception 'BLOCKED' using errcode = 'RA002', detail = array_to_string(snap.reasons, ',');
    end if;

    if ctx.tracking_mode = 'serialized' then
      select array_agg(id) into units from (
        select u.id
        from public.inventory_units u
        where u.variant_id = vid and u.status = 'active'
          and not exists (select 1 from public.availability_blocks b where b.inventory_unit_id = u.id and b.period && snap.occupied)
          and not exists (select 1 from public.reservation_allocations a
                          where a.inventory_unit_id = u.id and a.occupied_period && snap.occupied
                            and app.allocation_is_active(a.status, a.hold_expires_at))
        order by u.label, u.id
        limit qty
        for update skip locked
      ) free_units;
      if coalesce(cardinality(units), 0) < qty then
        raise exception 'INSUFFICIENT_AVAILABILITY' using errcode = 'RA001',
          detail = format('variant %s: requested %s, available %s', vid, qty, coalesce(cardinality(units), 0));
      end if;
      insert into public.reservation_allocations
        (organization_id, reservation_id, variant_id, inventory_unit_id, quantity, rental_period, occupied_period, status)
      select p_organization_id, rid, vid, u, 1, rental, snap.occupied, p_status
      from unnest(units) u;
    else
      if snap.available_quantity < qty then
        raise exception 'INSUFFICIENT_AVAILABILITY' using errcode = 'RA001',
          detail = format('variant %s: requested %s, available %s', vid, qty, snap.available_quantity);
      end if;
      insert into public.reservation_allocations
        (organization_id, reservation_id, variant_id, quantity, rental_period, occupied_period, status)
      values (p_organization_id, rid, vid, qty, rental, snap.occupied, p_status);
    end if;
  end loop;

  if old.id is not null then
    update public.reservations set replaced_by = rid where id = old.id;
  end if;
  return rid;
exception
  when exclusion_violation then
    -- Final guard: a concurrent writer took the unit between our check and insert.
    raise exception 'INSUFFICIENT_AVAILABILITY' using errcode = 'RA001';
end;
$$;

-- Confirms a live hold. Expired holds cannot be confirmed: their inventory may already be gone.
create function public.confirm_reservation(p_reservation_id uuid, p_ignore_weather boolean default false)
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
  select * into r from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  actor := app.assert_can_act(r.organization_id, 'availability.write');
  if r.status <> 'held' then
    raise exception 'INVALID_STATE: reservation is %', r.status using errcode = 'RA006';
  end if;
  if r.hold_expires_at <= now() then
    -- Already inactive (reads ignore it); the next writer or the sweeper marks it released.
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  if not (p_ignore_weather and actor = 'staff') and exists (
    select 1 from public.reservation_allocations a
    join public.product_variants v on v.id = a.variant_id
    where a.reservation_id = r.id and exists (select 1 from app.blocking_weather(v.product_id, a.rental_period))
  ) then
    raise exception 'BLOCKED' using errcode = 'RA002', detail = 'WEATHER_BLOCK';
  end if;
  update public.reservations set status = 'confirmed', hold_expires_at = null, confirmed_at = now() where id = r.id;
end;
$$;

-- Extends a live hold by the organization's hold duration, up to max_hold_renewals times.
create function public.renew_hold(p_reservation_id uuid)
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
  select * into r from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.assert_can_act(r.organization_id, 'availability.write');
  if r.status <> 'held' then
    raise exception 'INVALID_STATE: reservation is %', r.status using errcode = 'RA006';
  end if;
  if r.hold_expires_at <= now() then
    -- Already inactive (reads ignore it); the next writer or the sweeper marks it released.
    raise exception 'HOLD_EXPIRED' using errcode = 'RA004';
  end if;
  select * into s from public.organization_settings where organization_id = r.organization_id;
  if r.hold_renewals >= s.max_hold_renewals then
    raise exception 'HOLD_RENEWAL_LIMIT' using errcode = 'RA007';
  end if;
  expires := now() + make_interval(mins => s.booking_hold_minutes);
  update public.reservations set hold_expires_at = expires, hold_renewals = hold_renewals + 1 where id = r.id;
  return expires;
end;
$$;

-- Releases a hold, or (staff only) cancels a confirmed reservation. Idempotent for ended ones.
create function public.release_reservation(p_reservation_id uuid)
returns public.reservation_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.reservations;
  actor text;
  next_status public.reservation_status;
begin
  select * into r from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  actor := app.assert_can_act(r.organization_id, 'availability.write');
  if r.status in ('released', 'cancelled', 'completed') then
    return r.status;
  end if;
  if r.status = 'confirmed' and actor <> 'staff' then
    raise exception 'INVALID_STATE: only staff can cancel a confirmed booking' using errcode = 'RA006';
  end if;
  next_status := case when r.status = 'held' then 'released' else 'cancelled' end;
  update public.reservations set status = next_status, ended_at = now() where id = r.id;
  return next_status;
end;
$$;

-- Housekeeping only: correctness never depends on this running (expired holds are ignored anyway).
create function public.sweep_expired_holds()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update public.reservations set status = 'released', ended_at = now()
    where status = 'held' and hold_expires_at <= now()
    returning 1
  )
  select count(*)::integer from expired
$$;

-- ───────────────────────────── API: weather blocks ─────────────────────────────
create function public.confirm_weather_block(p_weather_block_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  w public.weather_blocks;
  flagged integer;
begin
  select * into w from public.weather_blocks where id = p_weather_block_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  -- Weather blocks are a staff decision (ADR 0010): never confirmed by the system context.
  if (select auth.uid()) is null or not app.has_permission(w.organization_id, 'availability.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if w.status <> 'proposed' then
    raise exception 'INVALID_STATE: weather block is %', w.status using errcode = 'RA006';
  end if;
  update public.weather_blocks set status = 'confirmed', confirmed_by = (select auth.uid()), confirmed_at = now()
  where id = w.id;

  -- Flag (never cancel) overlapping active reservations of affected products.
  with inserted as (
    insert into public.reservation_flags (organization_id, reservation_id, kind, weather_block_id, message)
    select distinct a.organization_id, a.reservation_id, 'weather_block'::public.reservation_flag_kind, w.id,
           'Confirmed ' || replace(w.hazard::text, '_', ' ') || ' block: ' || w.reason
    from public.reservation_allocations a
    join public.product_variants v on v.id = a.variant_id
    where a.organization_id = w.organization_id
      and a.rental_period && w.period
      and app.allocation_is_active(a.status, a.hold_expires_at)
      and w.id in (select app.blocking_weather(v.product_id, a.rental_period))
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into flagged from inserted;
  return flagged;
end;
$$;

create function public.lift_weather_block(p_weather_block_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  w public.weather_blocks;
begin
  select * into w from public.weather_blocks where id = p_weather_block_id for update;
  if not found or (select auth.uid()) is null or not app.has_permission(w.organization_id, 'availability.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if w.status = 'lifted' then
    return;
  end if;
  update public.weather_blocks set status = 'lifted', lifted_by = (select auth.uid()), lifted_at = now() where id = w.id;
end;
$$;

-- ───────────────────────────── grants ─────────────────────────────
revoke execute on function
  app.allocation_is_active(public.reservation_status, timestamptz),
  app.variant_context(uuid),
  app.blocking_weather(uuid, tstzrange),
  app.peak_usage(tstzrange, tstzrange[], integer[]),
  app.variant_availability(uuid, tstzrange),
  app.assert_can_act(uuid, text),
  app.parse_period(text, text),
  app.release_expired_holds(uuid[]),
  app.sync_allocation_status(),
  app.stamp_allocation_status(),
  app.availability_blocks_validate(),
  app.flag_reservations_for_block()
from public;

revoke execute on function
  public.check_availability(uuid, uuid, text, text, integer, boolean),
  public.check_public_availability(uuid, uuid, text, text, integer),
  public.reserve_inventory(uuid, jsonb, public.reservation_status, public.reservation_source, uuid, boolean, text),
  public.confirm_reservation(uuid, boolean),
  public.renew_hold(uuid),
  public.release_reservation(uuid),
  public.sweep_expired_holds(),
  public.confirm_weather_block(uuid),
  public.lift_weather_block(uuid)
from public, anon;

grant execute on function public.check_public_availability(uuid, uuid, text, text, integer) to anon, authenticated, service_role;
grant execute on function
  public.check_availability(uuid, uuid, text, text, integer, boolean),
  public.reserve_inventory(uuid, jsonb, public.reservation_status, public.reservation_source, uuid, boolean, text),
  public.confirm_reservation(uuid, boolean),
  public.renew_hold(uuid),
  public.release_reservation(uuid)
to authenticated, service_role;
grant execute on function public.confirm_weather_block(uuid), public.lift_weather_block(uuid) to authenticated;
grant execute on function public.sweep_expired_holds() to service_role;
