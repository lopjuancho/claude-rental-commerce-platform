-- Milestone 2 · Organization settings for road-distance delivery (ADR 0009) and wind safety (ADR 0010).

create type public.mileage_rounding as enum ('ceil_whole_mile', 'round_whole_mile', 'none');
create type public.mileage_basis as enum ('one_way', 'round_trip');

alter table public.organization_settings rename column max_wind_mph to wind_threshold_mph;
alter table public.organization_settings rename column depot_address_line1 to primary_depot_address_line1;
alter table public.organization_settings rename column depot_city to primary_depot_city;
alter table public.organization_settings rename column depot_state to primary_depot_state;
alter table public.organization_settings rename column depot_postal_code to primary_depot_postal_code;
alter table public.organization_settings rename column depot_latitude to primary_depot_latitude;
alter table public.organization_settings rename column depot_longitude to primary_depot_longitude;

alter table public.organization_settings
  add column free_delivery_miles     numeric(6, 2) check (free_delivery_miles >= 0),
  add column per_mile_rate_cents     bigint check (per_mile_rate_cents >= 0),
  add column maximum_delivery_miles  numeric(6, 2) check (maximum_delivery_miles > 0),
  add column mileage_rounding_method public.mileage_rounding not null default 'ceil_whole_mile',
  add column mileage_basis           public.mileage_basis not null default 'one_way',
  -- Mileage pricing is either fully configured or not configured at all.
  add constraint organization_settings_mileage_complete
    check ((free_delivery_miles is null) = (per_mile_rate_cents is null));
