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
