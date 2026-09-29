-- M5 hardening round 5 (Codex review of 5f8a9e3). ADR 0015 §16.
--
-- The organization gate is scoped to the mutation's TARGET organization(s), never to "every
-- organization the acting user belongs to":
--
-- 1. A mutation declares its targets before any row lock:
--    - staff writes through the API: the app's user client sends the active organization as the
--      `x-org-targets` request header (PostgREST exposes it as request.headers); the BEFORE STATEMENT
--      trigger locks only those declared organizations in which the user may write (catalog,
--      availability or settings), in ascending uuid order;
--    - functions: app.acquire_org_gates(<target orgs>) (weather confirm/lift, scripts);
--    - the service role: public.acquire_organization_gates(<target orgs>) first, in the same transaction.
-- 2. No gate is ever added after another is held: the statement trigger does nothing when the
--    transaction already holds a gate, and app.acquire_org_gates refuses (RA014) to add one.
-- 3. Row triggers only verify their row's organization gate. A row of an organization whose gate is
--    not held is refused (RA014) if the transaction holds another gate; with no gate at all (a
--    script/service write that did not declare one) the gate is tried without waiting and a busy
--    gate fails fast (55P03).

-- Declared targets of the current API request (validated uuids, ascending, distinct).
create function app.declared_org_targets()
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(distinct t order by t), '{}')
  from (select app.try_uuid(btrim(x)) t
        from unnest(string_to_array(
               coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-org-targets', ''), ',')) x) s
  where t is not null
$$;

create function app.holds_org_gate(p_organization_id uuid default null)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case when p_organization_id is null
    then coalesce(current_setting('app.locks_org_x', true), '') <> '' or coalesce(current_setting('app.locks_org_s', true), '') <> ''
    else position(p_organization_id::text || ',' in coalesce(current_setting('app.locks_org_x', true), '')) > 0
  end
$$;

-- The one gate protocol: exclusive gates of exactly the target organizations, ascending, taken
-- before any of their rows — and never after another organization's gate is already held.
create function app.acquire_org_gates(p_organization_ids uuid[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  org uuid;
  wanted uuid[] := array(select distinct x from unnest(p_organization_ids) x where x is not null order by x);
begin
  if exists (select 1 from unnest(wanted) x where not app.holds_org_gate(x)) and app.holds_org_gate() then
    raise exception 'LOCK_ORDER_VIOLATION: another organization gate is already held; declare every target up front'
      using errcode = 'RA014';
  end if;
  foreach org in array wanted loop
    perform app.lock_organization(org, true);
  end loop;
end;
$$;

-- Service role (scripts / server jobs): declare the targets first, in the same transaction.
create function public.acquire_organization_gates(p_organization_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.require_service_role();
  perform app.acquire_org_gates(p_organization_ids);
end;
$$;
revoke execute on function public.acquire_organization_gates(uuid[]) from public, anon, authenticated;
grant execute on function public.acquire_organization_gates(uuid[]) to service_role;

-- The gates of those target organizations in which the current user may write (catalog,
-- availability or settings); others are ignored, so nobody can hold another tenant's gate.
create function app.acquire_writable_org_gates(p_organization_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.acquire_org_gates(array(
    select t from unnest(p_organization_ids) t
    where app.has_permission(t, 'catalog.write') or app.has_permission(t, 'availability.write')
       or app.has_permission(t, 'settings.write')));
end;
$$;
revoke execute on function app.acquire_writable_org_gates(uuid[]) from public, anon;
grant execute on function app.acquire_writable_org_gates(uuid[]) to authenticated;

-- BEFORE STATEMENT: the declared targets the user may write, ascending — nothing else.
create or replace function app.org_gate_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or app.holds_org_gate() then
    return null;               -- no user (row triggers try without waiting) / nested: never add a gate
  end if;
  perform app.acquire_writable_org_gates(app.declared_org_targets());
  return null;
end;
$$;

-- Row triggers: verify the row's gate; never wait for it, never add one after another gate.
create or replace function app.require_org_gate(p_organization_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  k text;
begin
  if p_organization_id is null then
    raise exception 'require_org_gate: organization id is required' using errcode = 'RA006';
  end if;
  if app.holds_org_gate(p_organization_id) then
    return;                                            -- declared and taken before the row: normal path
  end if;
  k := p_organization_id::text || ',';
  if position(k in coalesce(current_setting('app.locks_org_s', true), '')) > 0 then
    raise exception 'LOCK_ORDER_VIOLATION: organization lock upgrade (shared → exclusive)' using errcode = 'RA014';
  end if;
  if app.holds_org_gate() then
    raise exception 'LOCK_ORDER_VIOLATION: a row of organization % outside the declared targets', p_organization_id
      using errcode = 'RA014';
  end if;
  -- Undeclared single-organization write (script / service): we already hold this row, never wait.
  if not pg_try_advisory_xact_lock(hashtextextended('org:' || p_organization_id::text, 0)) then
    raise exception 'ORGANIZATION_BUSY: another change to this organization is in progress; retry'
      using errcode = '55P03';
  end if;
  perform set_config('app.locks_org_x', coalesce(current_setting('app.locks_org_x', true), '') || k, true);
end;
$$;

-- Weather confirm/lift: the same protocol, for their target organization only.
CREATE OR REPLACE FUNCTION public.confirm_weather_block(p_weather_block_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  w public.weather_blocks;
  flagged integer;
begin
  select * into w from public.weather_blocks where id = p_weather_block_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  -- Weather blocks are a staff decision (ADR 0010): never confirmed by the system context.
  if (select auth.uid()) is null or not app.has_permission(w.organization_id, 'availability.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.acquire_org_gates(array[w.organization_id]);   -- the target organization only
  select * into w from public.weather_blocks where id = p_weather_block_id for update;
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
$function$;

CREATE OR REPLACE FUNCTION public.lift_weather_block(p_weather_block_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  w public.weather_blocks;
begin
  select * into w from public.weather_blocks where id = p_weather_block_id;
  if not found or (select auth.uid()) is null or not app.has_permission(w.organization_id, 'availability.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.acquire_org_gates(array[w.organization_id]);   -- the target organization only
  select * into w from public.weather_blocks where id = p_weather_block_id for update;
  if w.status = 'lifted' then
    return;
  end if;
  update public.weather_blocks set status = 'lifted', lifted_by = (select auth.uid()), lifted_at = now() where id = w.id;
end;
$function$;

revoke execute on function app.declared_org_targets(), app.holds_org_gate(uuid), app.acquire_org_gates(uuid[])
  from public, anon, authenticated, service_role;

-- Product import: its target (the batch organization) is known before any catalog row.
CREATE OR REPLACE FUNCTION public.commit_product_import(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  b public.import_batches;
  r public.import_rows;
  j jsonb;
  v public.products;
  pid uuid;
  vid uuid;
  cid uuid;
  cat jsonb;
  existed boolean;
  qty integer;
  have integer;
  total integer;
  mode public.tracking_mode;
  n_created integer := 0;
  n_updated integer := 0;
  n_skipped integer := 0;
  v_summary jsonb;
begin
  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'import batch not found' using errcode = 'no_data_found';
  end if;
  -- The batch's organization is the target: its gate first, before any catalog row (ADR 0015 §16).
  perform app.acquire_writable_org_gates(array[b.organization_id]);
  if b.status <> 'validated' then
    raise exception 'import batch must be validated before commit (status: %)', b.status
      using errcode = 'check_violation';
  end if;

  for r in select * from public.import_rows where batch_id = b.id order by row_number loop
    if r.action is null or r.action = 'skip' then
      n_skipped := n_skipped + 1;
      continue;
    end if;

    j := r.mapped;
    v := jsonb_populate_record(null::public.products, j);

    select p.id into pid
    from public.products p
    where p.organization_id = b.organization_id
      and ((v.external_ref is not null and p.external_source = b.external_source and p.external_ref = v.external_ref)
           or (v.external_ref is null and p.slug = v.slug))
    limit 1;
    existed := pid is not null;

    if existed then
      update public.products p set
        name = coalesce(v.name, p.name),
        short_description = coalesce(v.short_description, p.short_description),
        description = coalesce(v.description, p.description),
        is_published = coalesce(v.is_published, p.is_published),
        pricing_type = coalesce(v.pricing_type, p.pricing_type),
        base_price_cents = coalesce(v.base_price_cents, p.base_price_cents),
        included_duration_minutes = coalesce(v.included_duration_minutes, p.included_duration_minutes),
        minimum_rental_minutes = coalesce(v.minimum_rental_minutes, p.minimum_rental_minutes),
        setup_buffer_minutes = coalesce(v.setup_buffer_minutes, p.setup_buffer_minutes),
        teardown_buffer_minutes = coalesce(v.teardown_buffer_minutes, p.teardown_buffer_minutes),
        overnight_allowed = coalesce(v.overnight_allowed, p.overnight_allowed),
        wet_allowed = coalesce(v.wet_allowed, p.wet_allowed),
        dry_allowed = coalesce(v.dry_allowed, p.dry_allowed),
        minimum_age = coalesce(v.minimum_age, p.minimum_age),
        maximum_age = coalesce(v.maximum_age, p.maximum_age),
        recommended_capacity = coalesce(v.recommended_capacity, p.recommended_capacity),
        max_rider_weight_lbs = coalesce(v.max_rider_weight_lbs, p.max_rider_weight_lbs),
        ideal_event_types = case when j ? 'ideal_event_types' then v.ideal_event_types else p.ideal_event_types end,
        indoor_allowed = coalesce(v.indoor_allowed, p.indoor_allowed),
        outdoor_allowed = coalesce(v.outdoor_allowed, p.outdoor_allowed),
        allowed_surfaces = case when j ? 'allowed_surfaces' then v.allowed_surfaces else p.allowed_surfaces end,
        space_length_ft = coalesce(v.space_length_ft, p.space_length_ft),
        space_width_ft = coalesce(v.space_width_ft, p.space_width_ft),
        space_height_ft = coalesce(v.space_height_ft, p.space_height_ft),
        power_outlets_required = coalesce(v.power_outlets_required, p.power_outlets_required),
        power_notes = coalesce(v.power_notes, p.power_notes),
        water_required = coalesce(v.water_required, p.water_required),
        operator_required = coalesce(v.operator_required, p.operator_required),
        attendants_required = coalesce(v.attendants_required, p.attendants_required),
        setup_minutes = coalesce(v.setup_minutes, p.setup_minutes),
        teardown_minutes = coalesce(v.teardown_minutes, p.teardown_minutes),
        setup_requirements = coalesce(v.setup_requirements, p.setup_requirements),
        tags = case when j ? 'tags' then v.tags else p.tags end,
        internal_notes = coalesce(v.internal_notes, p.internal_notes)
      where p.id = pid;
      n_updated := n_updated + 1;
    else
      insert into public.products (
        organization_id, name, slug, short_description, description, is_published, pricing_type,
        base_price_cents, included_duration_minutes, minimum_rental_minutes, setup_buffer_minutes,
        teardown_buffer_minutes, overnight_allowed, wet_allowed, dry_allowed, minimum_age, maximum_age,
        recommended_capacity, max_rider_weight_lbs, ideal_event_types, indoor_allowed, outdoor_allowed,
        allowed_surfaces, space_length_ft, space_width_ft, space_height_ft, power_outlets_required,
        power_notes, water_required, operator_required, attendants_required, setup_minutes,
        teardown_minutes, setup_requirements, tags, internal_notes, external_source, external_ref
      ) values (
        b.organization_id, v.name, v.slug, v.short_description, v.description,
        coalesce(v.is_published, false), coalesce(v.pricing_type, 'per_event'), v.base_price_cents,
        v.included_duration_minutes, v.minimum_rental_minutes, v.setup_buffer_minutes,
        v.teardown_buffer_minutes, v.overnight_allowed,
        coalesce(v.wet_allowed, false), coalesce(v.dry_allowed, true), v.minimum_age, v.maximum_age,
        v.recommended_capacity, v.max_rider_weight_lbs, coalesce(v.ideal_event_types, '{}'),
        coalesce(v.indoor_allowed, false), coalesce(v.outdoor_allowed, true),
        coalesce(v.allowed_surfaces, '{}'), v.space_length_ft, v.space_width_ft, v.space_height_ft,
        v.power_outlets_required, v.power_notes, coalesce(v.water_required, false),
        coalesce(v.operator_required, false), coalesce(v.attendants_required, 0), v.setup_minutes,
        v.teardown_minutes, v.setup_requirements, coalesce(v.tags, '{}'), v.internal_notes,
        case when v.external_ref is null then null else b.external_source end, v.external_ref
      )
      returning id into pid;
      n_created := n_created + 1;
    end if;

    -- Product-level wind rule when the source says so (other hazards are configured in the admin).
    if jsonb_typeof(j -> 'wind_sensitive') = 'boolean' then
      insert into public.weather_hazard_rules (organization_id, product_id, hazard, sensitive)
      values (b.organization_id, pid, 'wind', (j ->> 'wind_sensitive')::boolean)
      on conflict (organization_id, category_id, product_id, hazard)
      do update set sensitive = excluded.sensitive;
    end if;

    if jsonb_typeof(j -> 'categories') = 'array' then
      for cat in select * from jsonb_array_elements(j -> 'categories') loop
        select c.id into cid from public.categories c
        where c.organization_id = b.organization_id and c.slug = cat ->> 'slug';
        if cid is null then
          insert into public.categories (organization_id, name, slug)
          values (b.organization_id, cat ->> 'name', cat ->> 'slug')
          returning id into cid;
        end if;
        insert into public.product_categories (organization_id, product_id, category_id)
        values (b.organization_id, pid, cid)
        on conflict do nothing;
        update public.products set primary_category_id = cid
        where id = pid and primary_category_id is null;
      end loop;
    end if;

    select pv.id, pv.tracking_mode into vid, mode
    from public.product_variants pv where pv.product_id = pid and pv.is_default;

    if not existed and j ->> 'tracking_mode' = 'pooled' then
      update public.product_variants
      set tracking_mode = 'pooled', pooled_quantity = coalesce((j ->> 'quantity')::integer, 0)
      where id = vid;
      mode := 'pooled';
    elsif j ? 'quantity' then
      qty := (j ->> 'quantity')::integer;
      if mode = 'pooled' then
        update public.product_variants set pooled_quantity = qty where id = vid;
      else
        select count(*) filter (where u.status = 'active'), count(*) into have, total
        from public.inventory_units u where u.variant_id = vid;
        insert into public.inventory_units (organization_id, variant_id, label)
        select b.organization_id, vid, 'Unit ' || (total + g)
        from generate_series(1, greatest(qty - have, 0)) g;
      end if;
    end if;

    update public.import_rows set target_id = pid where id = r.id;
  end loop;

  v_summary := jsonb_build_object('created', n_created, 'updated', n_updated, 'skipped', n_skipped);
  update public.import_batches
  set status = 'committed', committed_at = now(), summary = v_summary
  where id = b.id;
  return v_summary;
end;
$function$;
