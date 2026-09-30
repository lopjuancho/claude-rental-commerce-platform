-- M6 review fixes (ADR 0016 §9–12). Read-only, anon-safe views only; no change to pricing,
-- availability, hold or quote workflow rules.

-- Bookable variants carry the price the trusted pricing engine starts from
-- (`coalesce(variant override, product base)`, see public.pricing_context), so the storefront can
-- advertise exactly what a quote would use — never the product base when an override applies.
create or replace view public.public_catalog_variants
with (security_barrier = true) as
select v.id, v.organization_id, v.product_id, v.name, v.is_default,
       coalesce(v.price_override_cents, p.base_price_cents) as effective_base_price_cents
from public.product_variants v
join public.products p on p.id = v.product_id
join public.organizations o on o.id = v.organization_id
where o.status = 'active' and p.is_published and p.archived_at is null
  and v.is_active and v.archived_at is null;

-- Verified storefront hostnames. Search-engine indexing and canonical URLs are decided against
-- these only: an unverified domain may still resolve the tenant but is never indexable or canonical.
create view public.public_storefront_domains
with (security_barrier = true) as
select d.organization_id, d.hostname::text as hostname, d.is_primary
from public.organization_domains d
join public.organizations o on o.id = d.organization_id
where o.status = 'active' and d.verified_at is not null;

-- Per-category storefront facts computed in the database, so navigation and category cards never
-- depend on enumerating (and possibly truncating) the whole catalog.
create view public.public_catalog_category_summaries
with (security_barrier = true) as
select c.id as category_id, c.organization_id,
       (select count(*)::integer
        from public.product_categories pc
        join public.products p on p.id = pc.product_id
        where pc.category_id = c.id and p.is_published and p.archived_at is null) as product_count,
       cover.id as cover_media_id, cover.alt_text as cover_alt_text,
       cover.width as cover_width, cover.height as cover_height
from public.categories c
join public.organizations o on o.id = c.organization_id
left join lateral (
  select m.id, m.alt_text, m.width, m.height
  from public.product_media m
  join public.product_categories pc on pc.product_id = m.product_id and pc.category_id = c.id
  join public.products p on p.id = m.product_id
  where p.is_published and p.archived_at is null
    and m.kind = 'image' and m.rights_status <> 'unverified'
  order by p.is_featured desc, p.sort_order, p.name, p.id, m.is_primary desc, m.sort_order, m.id
  limit 1
) cover on true
where o.status = 'active' and c.is_published and c.archived_at is null;

-- Event types the published catalog is configured for (drives "Perfect for your event").
create view public.public_catalog_event_types
with (security_barrier = true) as
select p.organization_id, t.event_type::text as event_type, count(*)::integer as product_count
from public.products p
join public.organizations o on o.id = p.organization_id
cross join lateral unnest(p.ideal_event_types) as t(event_type)
where o.status = 'active' and p.is_published and p.archived_at is null
group by p.organization_id, t.event_type;

revoke all on public.public_catalog_variants, public.public_storefront_domains,
  public.public_catalog_category_summaries, public.public_catalog_event_types from anon, authenticated;
grant select on public.public_catalog_variants, public.public_storefront_domains,
  public.public_catalog_category_summaries, public.public_catalog_event_types
  to anon, authenticated, service_role;
