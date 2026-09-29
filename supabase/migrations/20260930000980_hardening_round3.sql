-- Hardening round 3 (Codex re-review of 3791ef1, B1 follow-up).
--
-- Failure: app.hold_invalid_reasons excluded every allocation of the reservation being confirmed
-- (o.reservation_id <> p_reservation_id) when checking pooled capacity, so each line of a
-- multi-line hold was validated as if the hold's other lines on the same variant did not exist.
-- Example: pooled quantity 4; one hold with two overlapping lines of 2 (fits: 4); a repair block
-- of 1 is added over them (allowed; it flags the hold). Each line then saw only "block 1 + itself
-- 2 = 3 ≤ 4" and the hold confirmed although 2 + 2 + 1 = 5 units are needed at once.
--
-- Fix: exclude only the line being checked (o.id <> a.id). Each line is then validated exactly as
-- hold creation validates it: peak of all other active allocations (other lines of this hold,
-- other holds, confirmed bookings; expired holds excluded) and partial blocks within the line's
-- fixed occupied period (buffers included), plus the line's own quantity, against the stock.

create or replace function app.hold_invalid_reasons(p_reservation_id uuid, p_actor text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.reservation_allocations;
  ctx record;
  why text[] := '{}';
  usage integer;
begin
  for a in select * from public.reservation_allocations where reservation_id = p_reservation_id loop
    select * into ctx from app.variant_context(a.variant_id);
    if not ctx.variant_active or ctx.product_archived then
      why := array_append(why, 'VARIANT_INACTIVE');
    end if;
    if p_actor = 'system' and (not ctx.product_published or ctx.organization_status <> 'active') then
      why := array_append(why, 'VARIANT_INACTIVE');
    end if;
    if exists (select 1 from public.availability_blocks b
               where b.organization_id = a.organization_id and b.period && a.occupied_period
                 and b.product_id is null and b.variant_id is null and b.inventory_unit_id is null) then
      why := array_append(why, 'BLACKOUT');
    end if;
    if exists (select 1 from public.availability_blocks b
               where b.period && a.occupied_period and b.quantity is null
                 and (b.product_id = ctx.product_id or b.variant_id = a.variant_id)) then
      why := array_append(why, 'PRODUCT_BLOCKED');
    end if;
    if a.inventory_unit_id is not null then
      if exists (select 1 from public.inventory_units u
                 where u.id = a.inventory_unit_id and (u.status <> 'active' or u.variant_id <> a.variant_id))
         or exists (select 1 from public.availability_blocks b
                    where b.inventory_unit_id = a.inventory_unit_id and b.period && a.occupied_period) then
        why := array_append(why, 'UNIT_UNAVAILABLE');
      end if;
    else
      -- Pooled: the same formula as hold creation (app.variant_availability): within this line's
      -- fixed occupied period, the peak of every OTHER active allocation of the variant — the
      -- hold's own other lines included — plus partial blocks, plus this line, must fit.
      select app.peak_usage(a.occupied_period, array_agg(x.r), array_agg(x.q)) into usage
      from (
        select o.occupied_period as r, o.quantity as q
        from public.reservation_allocations o
        where o.variant_id = a.variant_id and o.id <> a.id
          and o.occupied_period && a.occupied_period
          and app.allocation_is_active(o.status, o.hold_expires_at)
        union all
        select b.period, b.quantity
        from public.availability_blocks b
        where b.variant_id = a.variant_id and b.quantity is not null and b.period && a.occupied_period
      ) x;
      if ctx.tracking_mode <> 'pooled' or coalesce(usage, 0) + a.quantity > coalesce(ctx.pooled_quantity, 0) then
        why := array_append(why, 'INSUFFICIENT_QUANTITY');
      end if;
    end if;
  end loop;
  return array(select distinct x from unnest(why) x order by x);
end;
$$;
