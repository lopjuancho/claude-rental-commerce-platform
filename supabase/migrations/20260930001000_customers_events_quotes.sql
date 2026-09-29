-- Milestone 5 · Customers, events, quotes, booking requests (temporary holds).
-- Design: DATABASE.md §9, ADR 0001 (anonymous writes only through the server), ADR 0002 (draft /
-- 15-minute hold / confirmed), ADR 0013 (immutable pricing snapshots), ADR 0014 (hardening:
-- locks, trusted gateway, DST), ADR 0015 (quotes and booking requests).
--
-- Invariants enforced here, not in application code:
--   * Quote totals are copied from the referenced immutable pricing_calculations row by trigger;
--     nobody can write a total the engine did not produce.
--   * Quote items are derived from the same calculation's input, so items and totals always agree.
--   * Re-pricing is only possible in draft; a sent/accepted quote never changes.
--   * Status transitions are validated; a quote needing review cannot be sent or accepted until
--     a staff member approves the review.
--   * Holds and confirmations go through reserve_inventory / confirm_reservation (lock protocol
--     and confirmation re-validation from the hardening milestone).
--   * Event local times resolve through app.local_to_instant: nonexistent times are rejected,
--     times that happen twice need an explicit fold.
--   * Anonymous visitors never write directly: the server calls the service-role-only functions
--     at the end of this file (through the trusted gateway), always with the host-resolved tenant.
--
-- New SQLSTATEs: RA008 REVIEW_REQUIRED, RA009 QUOTE_EXPIRED, RA010 INVALID_STATE.

-- ───────────────────────────── settings ─────────────────────────────
alter table public.organization_settings
  add column quote_number_prefix text not null default 'Q-' check (quote_number_prefix ~ '^[A-Z0-9-]{0,8}$');

-- ───────────────────────────── customers ─────────────────────────────
create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  first_name      text check (length(first_name) <= 100),
  last_name       text check (length(last_name) <= 100),
  company_name    text check (length(company_name) <= 200),
  email           extensions.citext check (email is null or (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone_e164      text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  sms_opt_in      boolean not null default false,
  email_opt_in    boolean not null default false,
  source          text not null default 'admin' check (source in ('web', 'assistant', 'admin', 'import')),
  notes           text check (length(notes) <= 4000),
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  check (email is not null or phone_e164 is not null)
);
create unique index customers_org_email_key on public.customers (organization_id, email) where email is not null;
create unique index customers_org_phone_key on public.customers (organization_id, phone_e164) where phone_e164 is not null;
create index customers_org_email_lower_idx on public.customers (organization_id, lower(email::text));
create index customers_org_name_idx on public.customers (organization_id, last_name, first_name);

-- ───────────────────────────── events ─────────────────────────────
create type public.indoor_outdoor as enum ('indoor', 'outdoor', 'both', 'unknown');

create table public.events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  customer_id      uuid,
  event_type       public.event_type,
  title            text check (length(title) <= 200),
  -- Local date/time as the customer states them; starts_at/ends_at are derived (org time zone).
  event_date       date,
  end_date         date check (end_date >= event_date),
  start_time       time,
  end_time         time,
  -- Only consulted when a local time happens twice (DST fall-back): which occurrence is meant.
  time_fold        text check (time_fold in ('earlier', 'later')),
  starts_at        timestamptz,
  ends_at          timestamptz,
  address_line1    text check (length(address_line1) <= 200),
  address_line2    text check (length(address_line2) <= 200),
  city             text check (length(city) <= 120),
  state            text check (state ~ '^[A-Z]{2}$'),
  postal_code      text check (postal_code ~ '^\d{5}(-\d{4})?$'),
  guest_count      integer check (guest_count between 0 and 100000),
  children_count   integer check (children_count between 0 and 100000),
  age_min          smallint check (age_min between 0 and 120),
  age_max          smallint check (age_max between 0 and 120),
  budget_min_cents bigint check (budget_min_cents >= 0),
  budget_max_cents bigint check (budget_max_cents >= 0),
  indoor_outdoor   public.indoor_outdoor not null default 'unknown',
  water_available  boolean,
  power_available  boolean,
  surface_type     text check (surface_type in ('grass', 'concrete', 'asphalt', 'indoor_floor', 'dirt', 'other')),
  notes            text check (length(notes) <= 4000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  check (age_max >= age_min),
  check (budget_max_cents >= budget_min_cents),
  check (ends_at > starts_at)
);
create index events_org_starts_idx on public.events (organization_id, starts_at);
create index events_customer_idx on public.events (organization_id, customer_id);

-- Derives the instants from local date/time in the organization's time zone (ADR 0014 §4: a
-- nonexistent local time is rejected, an ambiguous one needs time_fold). An end time at or before
-- the start time on a single-date event means "the next day" (overnight).
create function app.events_derive_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tz text;
  end_day date;
begin
  if new.event_date is null or new.start_time is null or new.end_time is null then
    new.starts_at := null;
    new.ends_at := null;
    return new;
  end if;
  select o.timezone into tz from public.organizations o where o.id = new.organization_id;
  end_day := coalesce(new.end_date,
                      case when new.end_time <= new.start_time then new.event_date + 1 else new.event_date end);
  new.starts_at := app.local_to_instant(new.event_date + new.start_time, tz, new.time_fold);
  new.ends_at := app.local_to_instant(end_day + new.end_time, tz, new.time_fold);
  if new.ends_at <= new.starts_at then
    raise exception 'INVALID_REQUEST: event must end after it starts' using errcode = 'RA006';
  end if;
  return new;
end;
$$;
create trigger events_derive_period before insert or update on public.events
  for each row execute function app.events_derive_period();

-- ───────────────────────────── quotes ─────────────────────────────
create type public.quote_status as enum ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'cancelled');

create table public.quote_counters (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  next_value      bigint not null check (next_value > 0)
);

create table public.quotes (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  quote_number           text not null default '',   -- assigned by app.quotes_guard() (per-org counter)
  customer_id            uuid,
  event_id               uuid,
  status                 public.quote_status not null default 'draft',
  source                 text not null default 'admin' check (source in ('admin', 'web', 'assistant')),
  -- The pricing request (items, event address, discount codes, adjustments) re-run on "re-price".
  price_request          jsonb check (jsonb_typeof(price_request) = 'object' and pg_column_size(price_request) <= 32768),
  pricing_calculation_id uuid,
  -- Derived from the calculation by app.quotes_guard(); never written by callers.
  currency               char(3),
  subtotal_cents         bigint,
  delivery_cents         bigint,
  discount_cents         bigint,
  tax_cents              bigint,
  total_cents            bigint,
  manual_review_required boolean,
  review_reasons         text[],
  -- Staff sign-off for a price that needs review (reset whenever the quote is re-priced).
  review_approved_by     uuid references auth.users (id) on delete set null,
  review_approved_at     timestamptz,
  review_note            text check (length(review_note) <= 1000),
  -- sha256 of the customer link token; the token itself is shown once and never stored.
  token_hash             text unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at             timestamptz,
  sent_at                timestamptz,
  viewed_at              timestamptz,
  accepted_at            timestamptz,
  declined_at            timestamptz,
  cancelled_at           timestamptz,
  customer_notes         text check (length(customer_notes) <= 4000),
  internal_notes         text check (length(internal_notes) <= 4000),
  created_by_type        public.audit_actor_type not null default 'user',
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, quote_number),
  foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  foreign key (organization_id, event_id) references public.events (organization_id, id),
  foreign key (organization_id, pricing_calculation_id) references public.pricing_calculations (organization_id, id),
  check ((pricing_calculation_id is null) = (total_cents is null)),
  check (total_cents = subtotal_cents + tax_cents),
  check (status = 'draft' or pricing_calculation_id is not null)
);
create index quotes_org_status_idx on public.quotes (organization_id, status, created_at desc);
create index quotes_customer_idx on public.quotes (organization_id, customer_id);

create table public.quote_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  quote_id         uuid not null,
  line_id          text not null,
  variant_id       uuid not null,
  product_id       uuid not null,
  kind             text not null check (kind in ('rental', 'add_on')),
  quantity         integer not null check (quantity > 0),
  rental_period    tstzrange not null check (not isempty(rental_period)),
  product_name     text not null,                -- snapshot at pricing time
  unit_price_cents bigint not null,              -- base price per unit at pricing time
  line_total_cents bigint not null,              -- every engine line for this item (base, time, fees, discounts)
  sort_order       integer not null,
  unique (quote_id, line_id),
  foreign key (organization_id, quote_id) references public.quotes (organization_id, id) on delete cascade,
  foreign key (organization_id, product_id) references public.products (organization_id, id),
  foreign key (organization_id, variant_id) references public.product_variants (organization_id, id)
);

-- Allowed transitions (mirrored in src/domain/quotes/state-machine.ts).
create function app.quote_transition_allowed(p_from public.quote_status, p_to public.quote_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_from = p_to or (p_from, p_to) in (
    ('draft', 'sent'), ('draft', 'accepted'), ('draft', 'cancelled'),
    ('sent', 'viewed'), ('sent', 'accepted'), ('sent', 'declined'), ('sent', 'expired'), ('sent', 'cancelled'), ('sent', 'draft'),
    ('viewed', 'accepted'), ('viewed', 'declined'), ('viewed', 'expired'), ('viewed', 'cancelled'), ('viewed', 'draft'),
    ('expired', 'draft')
  )
$$;

create function app.quotes_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  calc public.pricing_calculations;
  s public.organization_settings;
  is_service boolean := (select auth.role()) = 'service_role';
  uid uuid := (select auth.uid());
  repriced boolean;
begin
  select * into s from public.organization_settings where organization_id = new.organization_id;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'INVALID_STATE: quotes start as drafts' using errcode = 'RA010';
    end if;
    insert into public.quote_counters as c (organization_id, next_value) values (new.organization_id, 1001)
    on conflict (organization_id) do update set next_value = c.next_value + 1
    returning s.quote_number_prefix || c.next_value into new.quote_number;
    if uid is not null then
      new.created_by_type := 'user';
      new.created_by := uid;
    elsif is_service then
      if new.created_by_type not in ('public', 'ai', 'system') then
        raise exception 'INVALID_REQUEST: created_by_type' using errcode = 'RA006';
      end if;
      new.created_by := null;
    end if;
    new.review_approved_by := null;
    new.review_approved_at := null;
    new.sent_at := null; new.viewed_at := null; new.accepted_at := null;
    new.declined_at := null; new.cancelled_at := null;
    repriced := new.pricing_calculation_id is not null;
  else
    if new.quote_number <> old.quote_number or new.created_by_type <> old.created_by_type
       or new.created_by is distinct from old.created_by or new.source <> old.source then
      raise exception 'INVALID_REQUEST: immutable quote field' using errcode = 'RA006';
    end if;
    repriced := new.pricing_calculation_id is distinct from old.pricing_calculation_id
                or new.price_request is distinct from old.price_request;
    if repriced and old.status <> 'draft' then
      raise exception 'INVALID_STATE: only draft quotes can be re-priced' using errcode = 'RA010';
    end if;
    if not app.quote_transition_allowed(old.status, new.status) then
      raise exception 'INVALID_STATE: % → % is not allowed', old.status, new.status using errcode = 'RA010';
    end if;
    -- Review sign-off: staff only, only for a priced quote that needs it, never carried across a re-price.
    if new.review_approved_at is distinct from old.review_approved_at
       or new.review_approved_by is distinct from old.review_approved_by then
      if uid is null then
        raise exception 'FORBIDDEN: only staff can approve a price review' using errcode = 'RA005';
      end if;
      if new.review_approved_at is not null then
        new.review_approved_at := now();
        new.review_approved_by := uid;
      else
        new.review_approved_by := null;
      end if;
    end if;
    if repriced then
      new.review_approved_at := null;
      new.review_approved_by := null;
      new.review_note := null;
    end if;
    new.sent_at := old.sent_at; new.viewed_at := old.viewed_at; new.accepted_at := old.accepted_at;
    new.declined_at := old.declined_at; new.cancelled_at := old.cancelled_at;
  end if;

  -- Totals come only from the immutable engine output.
  if new.pricing_calculation_id is null then
    new.currency := null; new.subtotal_cents := null; new.delivery_cents := null; new.discount_cents := null;
    new.tax_cents := null; new.total_cents := null; new.manual_review_required := null; new.review_reasons := null;
  else
    select * into calc from public.pricing_calculations
    where id = new.pricing_calculation_id and organization_id = new.organization_id;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'RA005';
    end if;
    if jsonb_array_length(calc.input -> 'items') = 0 then
      raise exception 'INVALID_REQUEST: a quote needs at least one item' using errcode = 'RA006';
    end if;
    new.currency := calc.currency;
    new.subtotal_cents := (calc.output #>> '{summary,subtotal}')::bigint;
    new.delivery_cents := (calc.output #>> '{summary,delivery}')::bigint;
    new.discount_cents := (calc.output #>> '{summary,discounts}')::bigint;
    new.tax_cents := (calc.output #>> '{summary,tax}')::bigint;
    new.total_cents := calc.total_cents;
    new.manual_review_required := calc.manual_review_required;
    new.review_reasons := array(select jsonb_array_elements_text(calc.output -> 'reviewReasons'));
  end if;

  if new.review_approved_at is not null and not coalesce(new.manual_review_required, false) then
    new.review_approved_at := null;
    new.review_approved_by := null;
  end if;

  if tg_op = 'UPDATE' and new.status <> old.status then
    if new.status in ('sent', 'accepted') and new.manual_review_required and new.review_approved_at is null then
      raise exception 'REVIEW_REQUIRED' using errcode = 'RA008';
    end if;
    case new.status
      when 'sent' then
        new.sent_at := now();
        if new.expires_at is null or new.expires_at <= now() then
          new.expires_at := now() + make_interval(days => s.quote_valid_days);
        end if;
      when 'viewed' then
        new.viewed_at := coalesce(old.viewed_at, now());
      when 'accepted' then
        if old.status in ('sent', 'viewed') and old.expires_at <= now() then
          raise exception 'QUOTE_EXPIRED' using errcode = 'RA009';
        end if;
        new.accepted_at := now();
      when 'declined' then
        new.declined_at := now();
      when 'cancelled' then
        new.cancelled_at := now();
      when 'draft' then
        new.expires_at := null;
      else
        null;
    end case;
  end if;
  return new;
end;
$$;
create trigger quotes_guard before insert or update on public.quotes
  for each row execute function app.quotes_guard();

-- Items mirror the calculation's input: they cannot drift from the priced snapshot.
create function app.quotes_sync_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.pricing_calculation_id is not distinct from old.pricing_calculation_id then
    return null;
  end if;
  delete from public.quote_items where quote_id = new.id;
  if new.pricing_calculation_id is null then
    return null;
  end if;
  insert into public.quote_items (organization_id, quote_id, line_id, variant_id, product_id, kind, quantity,
                                  rental_period, product_name, unit_price_cents, line_total_cents, sort_order)
  select new.organization_id, new.id, it ->> 'lineId', (it ->> 'variantId')::uuid, (it ->> 'productId')::uuid,
         it ->> 'kind', (it ->> 'quantity')::integer,
         tstzrange((it ->> 'start')::timestamptz, (it ->> 'end')::timestamptz, '[)'),
         it ->> 'name', (it ->> 'basePriceCents')::bigint,
         coalesce((select sum((l ->> 'amountCents')::bigint) from jsonb_array_elements(c.output -> 'lines') l
                   where l ->> 'lineId' = it ->> 'lineId'), 0),
         t.ord::integer
  from public.pricing_calculations c,
       jsonb_array_elements(c.input -> 'items') with ordinality as t(it, ord)
  where c.id = new.pricing_calculation_id;
  return null;
end;
$$;
create trigger quotes_sync_items after insert or update on public.quotes
  for each row execute function app.quotes_sync_items();

-- ───────────────────────────── booking requests ─────────────────────────────
create type public.booking_request_status as enum ('pending', 'confirmed', 'declined', 'cancelled');

create table public.booking_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  quote_id         uuid not null,
  customer_id      uuid,
  event_id         uuid,
  status           public.booking_request_status not null default 'pending',
  source           text not null check (source in ('web', 'assistant', 'admin')),
  reservation_id   uuid,                         -- the current hold, then the confirmed reservation
  customer_message text check (length(customer_message) <= 2000),
  decided_by       uuid references auth.users (id) on delete set null,
  decided_at       timestamptz,
  decision_note    text check (length(decision_note) <= 1000),
  created_by_type  public.audit_actor_type not null,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, quote_id) references public.quotes (organization_id, id),
  foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  foreign key (organization_id, event_id) references public.events (organization_id, id),
  foreign key (organization_id, reservation_id) references public.reservations (organization_id, id)
);
create unique index booking_requests_one_pending_per_quote on public.booking_requests (quote_id) where status = 'pending';
create index booking_requests_org_status_idx on public.booking_requests (organization_id, status, created_at desc);

-- M3 left these as plain columns until the tables existed.
alter table public.reservations
  add constraint reservations_quote_fk foreign key (organization_id, quote_id) references public.quotes (organization_id, id),
  add constraint reservations_event_fk foreign key (organization_id, event_id) references public.events (organization_id, id),
  add constraint reservations_booking_request_fk foreign key (organization_id, booking_request_id) references public.booking_requests (organization_id, id);

-- ───────────────────────────── common triggers, RLS ─────────────────────────────
create trigger customers_updated_at before update on public.customers for each row execute function app.set_updated_at();
create trigger events_updated_at before update on public.events for each row execute function app.set_updated_at();
create trigger quotes_updated_at before update on public.quotes for each row execute function app.set_updated_at();
create trigger booking_requests_updated_at before update on public.booking_requests for each row execute function app.set_updated_at();

create trigger audit_customers after insert or update or delete on public.customers
  for each row execute function app.audit_row_change('customer');
create trigger audit_events after insert or update or delete on public.events
  for each row execute function app.audit_row_change('event');
create trigger audit_quotes after insert or update or delete on public.quotes
  for each row execute function app.audit_row_change('quote');
create trigger audit_booking_requests after insert or update or delete on public.booking_requests
  for each row execute function app.audit_row_change('booking_request');

do $$
declare
  t text;
begin
  foreach t in array array['customers', 'events', 'quote_counters', 'quotes', 'quote_items', 'booking_requests'] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.prevent_organization_change()', t || '_org_immutable', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['events', 'quote_counters', 'quotes', 'quote_items', 'booking_requests'] loop
    execute format($p$create policy %I on public.%I for select to authenticated
                     using ((select app.has_permission(organization_id, 'org.read')))$p$, t || '_select', t);
  end loop;
end $$;

create policy customers_select on public.customers for select to authenticated
  using ((select app.has_permission(organization_id, 'customers.read')));
create policy customers_insert on public.customers for insert to authenticated
  with check ((select app.has_permission(organization_id, 'customers.write')));
create policy customers_update on public.customers for update to authenticated
  using ((select app.has_permission(organization_id, 'customers.write')))
  with check ((select app.has_permission(organization_id, 'customers.write')));

create policy events_insert on public.events for insert to authenticated
  with check ((select app.has_permission(organization_id, 'events.write')));
create policy events_update on public.events for update to authenticated
  using ((select app.has_permission(organization_id, 'events.write')))
  with check ((select app.has_permission(organization_id, 'events.write')));
create policy events_delete on public.events for delete to authenticated
  using ((select app.has_permission(organization_id, 'events.write')));

create policy quotes_insert on public.quotes for insert to authenticated
  with check ((select app.has_permission(organization_id, 'quotes.write')));
create policy quotes_update on public.quotes for update to authenticated
  using ((select app.has_permission(organization_id, 'quotes.write')))
  with check ((select app.has_permission(organization_id, 'quotes.write')));

-- Customers are archived, quotes cancelled: no deletes. Items, counters and booking requests are
-- written only by triggers and the functions below.
revoke delete on public.customers, public.quotes from authenticated;
revoke insert, update, delete on public.quote_items, public.quote_counters, public.booking_requests from authenticated;

-- ───────────────────────────── public catalog: bookable variants ─────────────────────────────
-- Read-only, anon-safe: the variant ids a visitor may put in a quote request (active variants of
-- published, non-archived products of active organizations). No prices, stock or internal fields.
create view public.public_catalog_variants
with (security_barrier = true) as
select v.id, v.organization_id, v.product_id, v.name, v.is_default
from public.product_variants v
join public.products p on p.id = v.product_id
join public.organizations o on o.id = v.organization_id
where o.status = 'active' and p.is_published and p.archived_at is null
  and v.is_active and v.archived_at is null;

revoke all on public.public_catalog_variants from anon, authenticated;
grant select on public.public_catalog_variants to anon, authenticated, service_role;

-- ───────────────────────────── API functions ─────────────────────────────

-- Finds a customer by email, then phone, or creates one. Existing values are never overwritten
-- (public input must not change a customer's record); only empty fields are filled.
-- Serialized per organization so concurrent submissions do not create duplicates.
create function public.match_or_create_customer(p_organization_id uuid, p_customer jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := app.assert_can_act(p_organization_id, 'customers.write');
  -- Lower-cased explicitly: with search_path = '' the citext "=" operator is not resolved and a
  -- plain comparison would silently be case-sensitive.
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
    select id into v_id from public.customers
    where organization_id = p_organization_id and phone_e164 = v_phone;
  end if;

  if v_id is null then
    insert into public.customers (organization_id, first_name, last_name, company_name, email, phone_e164,
                                  sms_opt_in, email_opt_in, source)
    values (p_organization_id, nullif(btrim(p_customer ->> 'firstName'), ''), nullif(btrim(p_customer ->> 'lastName'), ''),
            nullif(btrim(p_customer ->> 'companyName'), ''), v_email, v_phone,
            coalesce((p_customer ->> 'smsOptIn')::boolean, false), coalesce((p_customer ->> 'emailOptIn')::boolean, false),
            v_source)
    returning id into v_id;
  else
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

-- Starts (or returns the live) booking request for a quote, holding its items for the
-- organization's hold duration (ADR 0002). The server acting for the public calls this with the
-- system context; availability is enforced by reserve_inventory.
create function public.request_booking(p_quote_id uuid, p_source text default 'web', p_message text default null)
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
begin
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

  select * into br from public.booking_requests b where b.quote_id = q.id and b.status = 'pending' for update;
  if found then
    select * into res from public.reservations r where r.id = br.reservation_id;
    if res.status = 'held' and res.hold_expires_at > now() then
      return query select br.id, res.id, res.hold_expires_at;   -- idempotent
      return;
    end if;
  end if;

  select jsonb_agg(jsonb_build_object('variant_id', i.variant_id, 'quantity', i.quantity,
                                      'start', lower(i.rental_period), 'end', upper(i.rental_period))
                   order by i.sort_order)
  into items from public.quote_items i where i.quote_id = q.id;

  rid := public.reserve_inventory(q.organization_id, items, 'held', 'booking_request', null, false,
                                  'Booking request for quote ' || q.quote_number);

  if br.id is null then
    insert into public.booking_requests (organization_id, quote_id, customer_id, event_id, source, reservation_id,
                                         customer_message, created_by_type, created_by)
    values (q.organization_id, q.id, q.customer_id, q.event_id, p_source, rid, left(p_message, 2000),
            case when actor = 'staff' then 'user' when p_source = 'assistant' then 'ai' else 'public' end::public.audit_actor_type,
            (select auth.uid()))
    returning * into br;
  else
    update public.booking_requests set reservation_id = rid where id = br.id returning * into br;
  end if;
  update public.reservations r set quote_id = q.id, event_id = q.event_id, booking_request_id = br.id where r.id = rid
  returning * into res;
  return query select br.id, res.id, res.hold_expires_at;
end;
$$;

-- Extends the hold of a pending booking request (limits from M3's renew_hold).
create function public.renew_booking_hold(p_booking_request_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  br public.booking_requests;
begin
  select * into br from public.booking_requests where id = p_booking_request_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  perform app.assert_can_act(br.organization_id, 'availability.write');
  if br.status <> 'pending' then
    raise exception 'INVALID_STATE: booking request is %', br.status using errcode = 'RA010';
  end if;
  return public.renew_hold(br.reservation_id);
end;
$$;

-- Staff confirmation: the quote is accepted and the reservation becomes firm. A live hold is
-- confirmed; an expired hold is re-reserved as confirmed, which re-checks availability atomically
-- (and fails cleanly if the items were taken meanwhile).
create function public.confirm_booking_request(p_booking_request_id uuid, p_ignore_weather boolean default false)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  br public.booking_requests;
  q public.quotes;
  res public.reservations;
  items jsonb;
  rid uuid;
begin
  select * into br from public.booking_requests where id = p_booking_request_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if app.assert_can_act(br.organization_id, 'quotes.write') <> 'staff'
     or not app.has_permission(br.organization_id, 'availability.write') then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  if br.status <> 'pending' then
    raise exception 'INVALID_STATE: booking request is %', br.status using errcode = 'RA010';
  end if;
  select * into q from public.quotes where id = br.quote_id for update;
  if q.manual_review_required and q.review_approved_at is null then
    raise exception 'REVIEW_REQUIRED' using errcode = 'RA008';
  end if;

  select * into res from public.reservations where id = br.reservation_id for update;
  if res.status = 'held' and res.hold_expires_at > now() then
    perform public.confirm_reservation(res.id, p_ignore_weather);
    rid := res.id;
  else
    select jsonb_agg(jsonb_build_object('variant_id', i.variant_id, 'quantity', i.quantity,
                                        'start', lower(i.rental_period), 'end', upper(i.rental_period))
                     order by i.sort_order)
    into items from public.quote_items i where i.quote_id = q.id;
    -- Staff decided: the original request was inside the lead time, so it is not re-checked.
    rid := public.reserve_inventory(q.organization_id, items, 'confirmed', 'booking_request', null, true,
                                    'Booking request for quote ' || q.quote_number);
    update public.reservations r set quote_id = q.id, event_id = q.event_id, booking_request_id = br.id where r.id = rid;
  end if;

  update public.quotes set status = 'accepted' where id = q.id;
  update public.booking_requests
  set status = 'confirmed', reservation_id = rid, decided_by = (select auth.uid()), decided_at = now()
  where id = br.id;
  return rid;
end;
$$;

-- Declined by staff, or cancelled by the customer (system context) / staff. Releases the hold.
create function public.close_booking_request(p_booking_request_id uuid, p_status public.booking_request_status,
                                             p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  br public.booking_requests;
  actor text;
  res public.reservations;
begin
  select * into br from public.booking_requests where id = p_booking_request_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  actor := app.assert_can_act(br.organization_id, 'availability.write');
  if p_status not in ('declined', 'cancelled') or (p_status = 'declined' and actor <> 'staff') then
    raise exception 'INVALID_REQUEST: status' using errcode = 'RA006';
  end if;
  if br.status <> 'pending' then
    raise exception 'INVALID_STATE: booking request is %', br.status using errcode = 'RA010';
  end if;
  select * into res from public.reservations where id = br.reservation_id;
  if res.status = 'held' then
    perform public.release_reservation(res.id);
  end if;
  update public.booking_requests
  set status = p_status, decided_by = (select auth.uid()), decided_at = now(), decision_note = left(p_note, 1000)
  where id = br.id;
end;
$$;

-- Housekeeping: sent/viewed quotes past their expiry become 'expired'. Acceptance already refuses
-- them, so correctness never depends on this running.
create function public.expire_quotes()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update public.quotes set status = 'expired'
    where status in ('sent', 'viewed') and expires_at <= now()
    returning 1
  )
  select count(*)::integer from expired
$$;

-- ───────────────────────────── creation (staff and the server's public path) ─────────────────────────────

-- Creates an event from an explicit field list (never a generic row). Staff need events.write;
-- the system context (public/assistant flows) passes the host-resolved organization.
create function public.create_event(p_organization_id uuid, p_customer_id uuid, p_event jsonb)
returns table (event_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  e public.events;
begin
  perform app.assert_can_act(p_organization_id, 'events.write');
  if jsonb_typeof(p_event) <> 'object' then
    raise exception 'INVALID_REQUEST: event' using errcode = 'RA006';
  end if;
  insert into public.events (organization_id, customer_id, title, event_type, event_date, end_date, start_time,
                             end_time, time_fold, address_line1, address_line2, city, state, postal_code,
                             guest_count, children_count, surface_type, power_available, water_available, notes)
  values (p_organization_id, p_customer_id, p_event ->> 'title', (p_event ->> 'event_type')::public.event_type,
          (p_event ->> 'event_date')::date, (p_event ->> 'end_date')::date, (p_event ->> 'start_time')::time,
          (p_event ->> 'end_time')::time, p_event ->> 'time_fold', p_event ->> 'address_line1',
          p_event ->> 'address_line2', p_event ->> 'city', p_event ->> 'state', p_event ->> 'postal_code',
          (p_event ->> 'guest_count')::integer, (p_event ->> 'children_count')::integer, p_event ->> 'surface_type',
          (p_event ->> 'power_available')::boolean, (p_event ->> 'water_available')::boolean, p_event ->> 'notes')
  returning * into e;
  return query select e.id, e.starts_at, e.ends_at;
end;
$$;

-- Creates a draft quote on an immutable calculation of the same organization. Totals and items are
-- derived by triggers. Staff quotes are 'admin'; the system context may only create 'web' or
-- 'assistant' quotes (attributed to public/ai) and cannot set internal notes.
create function public.create_quote(
  p_organization_id uuid, p_customer_id uuid, p_event_id uuid, p_calculation_id uuid, p_price_request jsonb,
  p_source text, p_token_hash text default null, p_customer_notes text default null, p_internal_notes text default null
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
                             token_hash, customer_notes, internal_notes, created_by_type)
  values (p_organization_id, p_customer_id, p_event_id, p_source, p_price_request, p_calculation_id,
          p_token_hash, left(p_customer_notes, 4000), left(p_internal_notes, 4000),
          case when actor = 'staff' then 'user' when p_source = 'assistant' then 'ai' else 'public' end::public.audit_actor_type)
  returning * into q;
  return query select q.id, q.quote_number;
end;
$$;

-- ───────────────────────────── public (service role only, by link token) ─────────────────────────────
-- The server calls these for visitors: organization = host-resolved tenant, token_hash = sha256 of
-- the link token. A token never reaches another organization's quote.

create function app.require_service_role()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
end;
$$;

create function app.quote_by_token(p_organization_id uuid, p_token_hash text)
returns public.quotes
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  q public.quotes;
begin
  select * into q from public.quotes
  where organization_id = p_organization_id and token_hash = p_token_hash and p_token_hash ~ '^[0-9a-f]{64}$';
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'RA005';
  end if;
  return q;
end;
$$;

-- The customer's view of their quote: engine output (labels and amounts only), items, event,
-- booking state. Opening a sent quote marks it viewed. Unknown token → NULL.
create function public.public_quote_view(p_organization_id uuid, p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  q public.quotes;
  calc public.pricing_calculations;
  ev public.events;
  br record;
  hold_active boolean;
  expired boolean;
begin
  perform app.require_service_role();
  select * into q from public.quotes
  where organization_id = p_organization_id and token_hash = p_token_hash and p_token_hash ~ '^[0-9a-f]{64}$';
  if not found or q.pricing_calculation_id is null then
    return null;
  end if;
  if q.status = 'sent' then
    update public.quotes set status = 'viewed' where id = q.id returning * into q;
  end if;
  select * into calc from public.pricing_calculations where id = q.pricing_calculation_id;
  select * into ev from public.events where id = q.event_id;
  select b.status, r.status as res_status, r.hold_expires_at into br
  from public.booking_requests b left join public.reservations r on r.id = b.reservation_id
  where b.quote_id = q.id order by b.created_at desc limit 1;
  hold_active := br.status = 'pending' and br.res_status = 'held' and br.hold_expires_at > now();
  expired := q.status = 'expired' or (q.expires_at is not null and q.expires_at <= now());
  return jsonb_build_object(
    'quoteNumber', q.quote_number,
    'status', q.status,
    'expired', expired,
    'expiresAt', q.expires_at,
    'currency', calc.currency,
    'priceIsFinal', not q.manual_review_required or q.review_approved_at is not null,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('label', l ->> 'label', 'amountCents', (l ->> 'amountCents')::bigint,
                                                          'kind', l ->> 'kind'))
                       from jsonb_array_elements(calc.output -> 'lines') l), '[]'::jsonb),
    'taxLines', coalesce((select jsonb_agg(jsonb_build_object('name', t ->> 'name', 'amountCents', (t ->> 'amountCents')::bigint))
                          from jsonb_array_elements(calc.output -> 'taxLines') t), '[]'::jsonb),
    'subtotalCents', q.subtotal_cents,
    'taxCents', q.tax_cents,
    'totalCents', q.total_cents,
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'quantity', i.quantity,
                                                          'start', lower(i.rental_period), 'end', upper(i.rental_period))
                                        order by i.sort_order)
                       from public.quote_items i where i.quote_id = q.id), '[]'::jsonb),
    'event', case when ev.id is null then null else jsonb_build_object(
      'startsAt', ev.starts_at, 'endsAt', ev.ends_at,
      'address', case when ev.address_line1 is null then null
                      else concat_ws(', ', ev.address_line1, ev.city, concat_ws(' ', ev.state, ev.postal_code)) end) end,
    'booking', case when br.status is null then null else jsonb_build_object(
      'status', br.status, 'holdExpiresAt', br.hold_expires_at, 'holdActive', coalesce(hold_active, false)) end,
    'canRequestBooking', not expired and q.status in ('draft', 'sent', 'viewed')
                         and coalesce(br.status::text, '') <> 'confirmed'
  );
end;
$$;

create function public.request_booking_by_token(p_organization_id uuid, p_token_hash text, p_source text,
                                                 p_message text default null)
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
  q := app.quote_by_token(p_organization_id, p_token_hash);
  return query select b.booking_request_id, b.reservation_id, b.hold_expires_at, q.quote_number
               from public.request_booking(q.id, p_source, p_message) b;
end;
$$;

create function app.pending_request_by_token(p_organization_id uuid, p_token_hash text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  q public.quotes := app.quote_by_token(p_organization_id, p_token_hash);
  id uuid;
begin
  select b.id into id from public.booking_requests b where b.quote_id = q.id and b.status = 'pending';
  if id is null then
    raise exception 'NOT_FOUND: no pending booking request' using errcode = 'RA005';
  end if;
  return id;
end;
$$;

create function public.renew_booking_hold_by_token(p_organization_id uuid, p_token_hash text)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.require_service_role();
  return public.renew_booking_hold(app.pending_request_by_token(p_organization_id, p_token_hash));
end;
$$;

create function public.cancel_booking_by_token(p_organization_id uuid, p_token_hash text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  id uuid;
begin
  perform app.require_service_role();
  id := app.pending_request_by_token(p_organization_id, p_token_hash);
  perform public.close_booking_request(id, 'cancelled');
  return id;
end;
$$;

revoke execute on function
  app.require_service_role(),
  app.quote_by_token(uuid, text),
  app.pending_request_by_token(uuid, text),
  app.events_derive_period(),
  app.quote_transition_allowed(public.quote_status, public.quote_status),
  app.quotes_guard(),
  app.quotes_sync_items()
from public;
revoke execute on function
  public.create_event(uuid, uuid, jsonb),
  public.create_quote(uuid, uuid, uuid, uuid, jsonb, text, text, text, text)
from public, anon;
-- Visitor-facing operations: the server (service role) only.
revoke execute on function
  public.public_quote_view(uuid, text),
  public.request_booking_by_token(uuid, text, text, text),
  public.renew_booking_hold_by_token(uuid, text),
  public.cancel_booking_by_token(uuid, text)
from public, anon, authenticated;
grant execute on function
  public.create_event(uuid, uuid, jsonb),
  public.create_quote(uuid, uuid, uuid, uuid, jsonb, text, text, text, text)
to authenticated, service_role;
grant execute on function
  public.public_quote_view(uuid, text),
  public.request_booking_by_token(uuid, text, text, text),
  public.renew_booking_hold_by_token(uuid, text),
  public.cancel_booking_by_token(uuid, text)
to service_role;

revoke execute on function
  public.match_or_create_customer(uuid, jsonb),
  public.request_booking(uuid, text, text),
  public.renew_booking_hold(uuid),
  public.confirm_booking_request(uuid, boolean),
  public.close_booking_request(uuid, public.booking_request_status, text),
  public.expire_quotes()
from public, anon;
grant execute on function
  public.match_or_create_customer(uuid, jsonb),
  public.request_booking(uuid, text, text),
  public.renew_booking_hold(uuid),
  public.close_booking_request(uuid, public.booking_request_status, text)
to authenticated, service_role;
-- Confirming a booking is a staff decision; sweeping expired quotes is housekeeping for the server.
revoke execute on function public.confirm_booking_request(uuid, boolean) from service_role;
grant execute on function public.confirm_booking_request(uuid, boolean) to authenticated;
revoke execute on function public.expire_quotes() from authenticated;
grant execute on function public.expire_quotes() to service_role;
