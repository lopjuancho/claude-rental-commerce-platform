-- Local development fixtures ONLY. Fictional tenants and users; no real business or customer data.
-- Real tenants (including Tiky Jumps) are onboarded with the tenant import tooling, not this file.
-- All users share the password: dev-password-123

do $$
declare
  v_pw text := extensions.crypt('dev-password-123', extensions.gen_salt('bf'));
  v_users constant jsonb := '[
    {"id":"a0000000-0000-4000-8000-000000000001","email":"owner@acme.test","name":"Avery Owner"},
    {"id":"a0000000-0000-4000-8000-000000000002","email":"admin@acme.test","name":"Alex Admin"},
    {"id":"a0000000-0000-4000-8000-000000000003","email":"office@acme.test","name":"Olivia Office"},
    {"id":"a0000000-0000-4000-8000-000000000004","email":"staff@acme.test","name":"Sam Staff"},
    {"id":"b0000000-0000-4000-8000-000000000001","email":"owner@funtime.test","name":"Frankie Owner"},
    {"id":"c0000000-0000-4000-8000-000000000001","email":"multi@example.test","name":"Morgan Multi"}
  ]';
  u jsonb;
begin
  for u in select * from jsonb_array_elements(v_users) loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', (u->>'id')::uuid, 'authenticated', 'authenticated',
            u->>'email', v_pw, now(), '{"provider":"email","providers":["email"]}',
            jsonb_build_object('full_name', u->>'name'), now(), now())
    on conflict (id) do nothing;

    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values ((u->>'id')::uuid, u->>'id', (u->>'id')::uuid,
            jsonb_build_object('sub', u->>'id', 'email', u->>'email', 'email_verified', true),
            'email', now(), now(), now())
    on conflict (id) do nothing;
  end loop;
end $$;

-- Every organization this seed writes is declared up front (ADR 0015 §16): its gates are taken
-- before any of their rows. The seed runs as one transaction (the Supabase CLI sends it as a batch).
select app.acquire_org_gates(array['10000000-0000-4000-8000-000000000001',
                                   '20000000-0000-4000-8000-000000000001']::uuid[]);

insert into public.organizations (id, slug, name, legal_name, status, timezone) values
  ('10000000-0000-4000-8000-000000000001', 'acme',    'Acme Party Rentals', 'Acme Party Rentals LLC', 'active', 'America/Chicago'),
  ('20000000-0000-4000-8000-000000000001', 'funtime', 'FunTime Rentals',    'FunTime Rentals Inc.',   'active', 'America/New_York')
on conflict (id) do nothing;

insert into public.organization_domains (organization_id, hostname, is_primary, verified_at) values
  ('10000000-0000-4000-8000-000000000001', 'acme.localhost',    true, now()),
  ('20000000-0000-4000-8000-000000000001', 'funtime.localhost', true, now())
on conflict (hostname) do nothing;

update public.organization_settings set
  primary_color = '#2563eb', secondary_color = '#f59e0b',
  contact_phone = '+15555550100', contact_email = 'hello@acme.test', website_url = 'https://acme.test'
where organization_id = '10000000-0000-4000-8000-000000000001';

update public.organization_settings set
  primary_color = '#db2777', secondary_color = '#10b981',
  contact_phone = '+15555550200', contact_email = 'hello@funtime.test', website_url = 'https://funtime.test'
where organization_id = '20000000-0000-4000-8000-000000000001';

insert into public.organization_members (organization_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'owner'),
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'admin'),
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'office'),
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000004', 'staff'),
  ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'owner'),
  -- a user who belongs to two organizations (exercises the org switcher)
  ('10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'office'),
  ('20000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'staff')
on conflict do nothing;

insert into public.organization_policies (organization_id, policy_type, title, body, is_published) values
  ('10000000-0000-4000-8000-000000000001', 'weather', 'Weather policy',
   'Placeholder policy text for local development.', true),
  ('20000000-0000-4000-8000-000000000001', 'cancellation', 'Cancellation policy',
   'Placeholder policy text for local development.', true);

-- Fictional catalog for local development (no real business data or photos).
insert into public.categories (id, organization_id, name, slug, sort_order, included_duration_minutes) values
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Bounce Houses', 'bounce-houses', 10, null),
  ('11000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Water Slides', 'water-slides', 20, 240),
  ('11000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Tables & Chairs', 'tables-and-chairs', 30, null)
on conflict do nothing;

insert into public.weather_hazard_rules (organization_id, category_id, hazard, sensitive, threshold_value, threshold_unit) values
  ('10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'wind', true, 20, 'mph'),
  ('10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'wind', true, 20, 'mph'),
  ('10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'lightning', true, null, null)
on conflict do nothing;

insert into public.products (id, organization_id, primary_category_id, name, slug, short_description, is_published,
                             base_price_cents, wet_allowed, dry_allowed, minimum_age, maximum_age, recommended_capacity,
                             space_length_ft, space_width_ft, space_height_ft, power_outlets_required, ideal_event_types, tags) values
  ('12000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
   'Sample Castle', 'sample-castle', 'A fictional 13x13 castle for development.', true, 17500, false, true, 3, 10, 8,
   15, 15, 14, 1, '{birthday,school}', '{castle}'),
  ('12000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002',
   'Sample Wave Slide', 'sample-wave-slide', 'A fictional 18 ft dual-lane slide.', true, 42500, true, true, 5, 14, 4,
   32, 15, 18, 2, '{birthday,community}', '{slide,wet}'),
  ('12000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   'Folding Chair', 'folding-chair', null, true, 250, false, true, null, null, null, null, null, null, null, '{}', '{}')
on conflict do nothing;

insert into public.product_categories (organization_id, product_id, category_id)
select organization_id, id, primary_category_id from public.products
where organization_id = '10000000-0000-4000-8000-000000000001'
on conflict do nothing;

insert into public.inventory_units (organization_id, variant_id, label)
select v.organization_id, v.id, 'Unit ' || g
from public.product_variants v, generate_series(1, 2) g
where v.product_id in ('12000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000002')
on conflict do nothing;

update public.product_variants set tracking_mode = 'pooled', pooled_quantity = 200
where product_id = '12000000-0000-4000-8000-000000000003';
