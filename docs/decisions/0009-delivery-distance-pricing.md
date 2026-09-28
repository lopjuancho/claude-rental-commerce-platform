# 0009 — Road-distance delivery pricing behind a provider abstraction (D15)

**Status:** Accepted 2026-09-28 · Implemented in M4 (schema settings columns land earlier where noted)

## Decision

### Provider abstraction
Business logic depends only on an interface; no vendor SDK or response shape leaks past it.

```ts
interface DistanceProvider {
  readonly id: string;                                   // "google", "mapbox", "fake"
  getRoadDistance(origin: RouteEndpoint, destination: RouteEndpoint): Promise<RoadDistanceResult>;
}
type RouteEndpoint = { address: PostalAddress } | { coordinates: { lat: number; lng: number } };
type RoadDistanceResult =
  | { ok: true; meters: number; provider: string; resolvedDestination?: string }
  | { ok: false; reason: "ADDRESS_NOT_FOUND" | "AMBIGUOUS_ADDRESS" | "NO_ROUTE" | "PROVIDER_ERROR" };
```

The first real provider (Google Maps or Mapbox) is an adapter in `src/server/delivery/providers/`. Tests use a deterministic fake. **Straight-line distance is never used for billing.**

### Configuration (organization settings; multiple depots later)

| Setting | Type | Tiky Jumps |
|---|---|---|
| `primary_depot_address_*` (+ optional lat/lng) | address | their depot |
| `free_delivery_miles` | numeric(6,2) | 5 |
| `per_mile_rate_cents` | bigint | 400 |
| `maximum_delivery_miles` | numeric(6,2), nullable = no maximum | to confirm |
| `mileage_rounding_method` | enum `ceil_whole_mile` \| `round_whole_mile` \| `none` | `ceil_whole_mile` |
| `mileage_basis` | enum `one_way` \| `round_trip` | `one_way` |

Multiple depots later: an `organization_depots` table; the primary depot columns become the default depot. The calculation takes an explicit origin so nothing else changes.

### Calculation (pure, `src/domain/delivery/mileage.ts`)
1. Distance comes back in meters from the provider; convert to miles and round to **hundredths** (1 mi = 1609.344 m) so floating-point noise never changes a bill.
2. If `maximum_delivery_miles` is set and distance > maximum → `manual_review` (`OUTSIDE_MAX_DISTANCE`).
3. `billable = max(0, distance − free_delivery_miles)`, then apply rounding (`ceil_whole_mile`: ceil to the next whole mile).
4. `fee = billable × per_mile_rate_cents`.

Example: 8.2 mi, 5 free → ceil(3.2) = 4 → 4 × $4 = **$16**.

### Resolution order (`check_service_area`)
1. Explicit service-area zone match (postal code, then city + state) → that zone's configured fee / review flag.
2. Mileage configuration present → road distance → fee, or `manual_review` if beyond maximum.
3. Otherwise, or on any provider failure (address not found, ambiguous, no route, outage) → **`manual_review`, no price**. The system never invents a delivery charge, and the assistant must say a team member will confirm delivery.

### Caching
- `delivery_distance_cache`: organization-scoped (destination addresses are customer data), keyed by provider + SHA-256 of the normalized origin and destination, storing meters and `expires_at`.
- Default TTL 30 days, configurable, so provider terms that restrict caching can be honoured.
- Quotes store the distance and provider used in their pricing snapshot, so a later cache miss or price change never alters an existing quote.
