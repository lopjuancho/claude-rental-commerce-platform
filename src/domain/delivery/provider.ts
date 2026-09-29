import type { PostalAddress } from "./address";

/**
 * Road-distance provider abstraction (ADR 0009). Business logic depends only on this; Google Maps
 * is one implementation (src/server/delivery/providers/google-routes.ts).
 */
export type RoadDistanceResult =
  | { ok: true; meters: number }
  | {
      ok: false;
      reason: "ADDRESS_NOT_FOUND" | "AMBIGUOUS_ADDRESS" | "NO_ROUTE" | "PROVIDER_ERROR";
    };

export interface DistanceProvider {
  /** Stable id stored with cached distances, e.g. "google_routes". */
  readonly id: string;
  /** Bumped when the provider's request/interpretation changes, invalidating cached distances. */
  readonly version: string;
  getRoadDistance(origin: PostalAddress, destination: PostalAddress): Promise<RoadDistanceResult>;
}

/** Cache of provider distances (organization-scoped; see public.get_cached_distance). */
export interface DistanceCache {
  get(key: { provider: string; version: string; routeKey: string }): Promise<number | null>;
  put(key: { provider: string; version: string; routeKey: string }, meters: number): Promise<void>;
}
