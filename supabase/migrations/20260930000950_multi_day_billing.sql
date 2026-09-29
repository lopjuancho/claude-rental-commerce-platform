-- Multi-day billing strategy (approved with M4, 2026-09-30; ADR 0013).
-- How a rental period becomes billable days is an organization setting so other rental companies
-- can bill differently (e.g. rolling_24h: Fri 5 PM → Sun noon = 2 days; calendar_days: 3 days).
create type public.multi_day_billing as enum ('rolling_24h', 'calendar_days');

alter table public.organization_settings
  add column multi_day_billing public.multi_day_billing not null default 'rolling_24h';

-- pricing_context now reports the strategy (organization.multiDayBilling).
create or replace function public.pricing_context(p_organization_id uuid, p_variant_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform app.assert_can_act(p_organization_id, 'org.read');
  if cardinality(p_variant_ids) > 50 then
    raise exception 'INVALID_REQUEST: too many items' using errcode = 'RA006';
  end if;

  select jsonb_build_object(
    'organization', jsonb_build_object(
      'id', o.id, 'currency', o.currency, 'timezone', o.timezone, 'status', o.status,
      'multiDayBilling', s.multi_day_billing),
    'delivery', jsonb_build_object(
      'depot', case when s.primary_depot_address_line1 is null then null else jsonb_build_object(
        'line1', s.primary_depot_address_line1, 'city', s.primary_depot_city,
        'state', s.primary_depot_state, 'postalCode', s.primary_depot_postal_code) end,
      'freeMiles', s.free_delivery_miles, 'perMileRateCents', s.per_mile_rate_cents,
      'maximumMiles', s.maximum_delivery_miles, 'rounding', s.mileage_rounding_method, 'basis', s.mileage_basis),
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variantId', v.id, 'productId', p.id,
        'name', case when v.is_default then p.name else p.name || ' — ' || v.name end,
        'primaryCategoryId', p.primary_category_id,
        'categoryIds', coalesce((select jsonb_agg(pc.category_id order by pc.category_id) from public.product_categories pc where pc.product_id = p.id), '[]'::jsonb),
        'basePriceCents', coalesce(v.price_override_cents, p.base_price_cents),
        'includedDurationMinutes', coalesce(p.included_duration_minutes, c.included_duration_minutes, s.default_rental_duration_minutes),
        'overnightAllowed', coalesce(p.overnight_allowed, c.overnight_allowed, s.overnight_allowed),
        'attendantsRequired', p.attendants_required,
        'published', p.is_published and p.archived_at is null,
        'active', v.is_active and v.archived_at is null and p.archived_at is null
      ) order by v.id)
      from public.product_variants v
      join public.products p on p.id = v.product_id
      left join public.categories c on c.id = p.primary_category_id
      where v.organization_id = o.id and v.id = any (p_variant_ids)
    ), '[]'::jsonb),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'revision', r.revision, 'name', r.name, 'type', r.rule_type,
        'categoryId', r.category_id, 'productId', r.product_id, 'variantId', r.variant_id,
        'params', r.params, 'priority', r.priority, 'discountCode', r.discount_code::text,
        'validFrom', r.valid_from, 'validTo', r.valid_to
      ) order by r.id)
      from public.pricing_rules r where r.organization_id = o.id and r.is_active
    ), '[]'::jsonb)
  )
  into result
  from public.organizations o
  join public.organization_settings s on s.organization_id = o.id
  where o.id = p_organization_id;
  return result;
end;
$$;
