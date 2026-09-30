-- M6 storefront: anon-safe public data for the tenant storefront (ADR 0016).
--
-- Explicit-column views in the same style as the M2 catalog views: active organizations only,
-- published only, no internal fields. The organization is always the host-resolved tenant, chosen
-- by the server; these views only ever narrow what anonymous visitors can read.

-- Business profile shown on the storefront (footer, LocalBusiness data, delivery messaging).
create view public.public_storefront_settings
with (security_barrier = true) as
select s.organization_id, s.address_line1, s.city, s.state, s.postal_code,
       s.free_delivery_miles, s.maximum_delivery_miles,
       (select d.hostname from public.organization_domains d
        where d.organization_id = s.organization_id and d.is_primary and d.verified_at is not null
        order by d.created_at limit 1) as primary_hostname
from public.organization_settings s
join public.organizations o on o.id = s.organization_id
where o.status = 'active';

-- Published, owner-approved policies (placeholders awaiting approval are never shown).
create view public.public_storefront_policies
with (security_barrier = true) as
select p.id, p.organization_id, p.policy_type, p.title, p.body, p.version, p.updated_at
from public.organization_policies p
join public.organizations o on o.id = p.organization_id
where o.status = 'active' and p.is_published and not p.is_placeholder;

-- Names of active delivery service areas (no pricing internals).
create view public.public_service_areas
with (security_barrier = true) as
select a.id, a.organization_id, a.name, a.priority
from public.service_areas a
join public.organizations o on o.id = a.organization_id
where o.status = 'active' and a.is_active;

revoke all on public.public_storefront_settings, public.public_storefront_policies, public.public_service_areas
  from anon, authenticated;
grant select on public.public_storefront_settings, public.public_storefront_policies, public.public_service_areas
  to anon, authenticated, service_role;

-- Product images: visitors may read exactly the objects listed in the published, rights-verified
-- media view — nothing else in the private bucket (drafts, unpublished products, other files).
create policy product_media_objects_public_select on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-media'
         and exists (select 1 from public.public_catalog_product_media m where m.storage_path = name));

-- The customer's quote view reports a stale quote (event changed since pricing) and never offers
-- a booking request for it; items carry their variant/product so an updated quote can be prefilled.
create or replace function public.public_quote_view(p_organization_id uuid, p_token_hash text)
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
  stale boolean;
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
  -- An open quote whose event no longer matches its priced snapshot (ADR 0015 §11–12) cannot be
  -- booked as is: it must be recalculated. The storefront says so instead of offering "Request booking".
  stale := q.status in ('draft', 'sent', 'viewed') and app.quote_event_mismatch(q);
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
    'stale', stale,
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'quantity', i.quantity,
                                                          'variantId', i.variant_id, 'productId', i.product_id,
                                                          'start', lower(i.rental_period), 'end', upper(i.rental_period))
                                        order by i.sort_order)
                       from public.quote_items i where i.quote_id = q.id), '[]'::jsonb),
    'event', case when ev.id is null then null else jsonb_build_object(
      'startsAt', ev.starts_at, 'endsAt', ev.ends_at,
      'address', case when ev.address_line1 is null then null
                      else concat_ws(', ', ev.address_line1, ev.city, concat_ws(' ', ev.state, ev.postal_code)) end) end,
    'booking', case when br.status is null then null else jsonb_build_object(
      'status', br.status, 'holdExpiresAt', br.hold_expires_at, 'holdActive', coalesce(hold_active, false)) end,
    'canRequestBooking', not expired and not stale and q.status in ('draft', 'sent', 'viewed')
                         and coalesce(br.status::text, '') <> 'confirmed'
  );
end;
$$;
