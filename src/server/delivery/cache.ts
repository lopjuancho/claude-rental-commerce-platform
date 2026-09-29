import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DistanceCache } from "@/domain/delivery/provider";
import type { Database } from "@/types/database";

/** Organization-scoped distance cache in Postgres (TTL ≤ 30 days to respect provider terms). */
export class DatabaseDistanceCache implements DistanceCache {
  constructor(
    private readonly db: SupabaseClient<Database>,
    private readonly organizationId: string,
    private readonly ttlDays = 30,
  ) {}

  async get(key: { provider: string; version: string; routeKey: string }): Promise<number | null> {
    const { data, error } = await this.db.rpc("get_cached_distance", {
      p_organization_id: this.organizationId,
      p_provider: key.provider,
      p_provider_version: key.version,
      p_route_key: key.routeKey,
    });
    if (error) throw new Error("distance cache read failed", { cause: error });
    return data;
  }

  async put(
    key: { provider: string; version: string; routeKey: string },
    meters: number,
  ): Promise<void> {
    const { error } = await this.db.rpc("put_cached_distance", {
      p_organization_id: this.organizationId,
      p_provider: key.provider,
      p_provider_version: key.version,
      p_route_key: key.routeKey,
      p_meters: Math.round(meters),
      p_ttl_days: this.ttlDays,
    });
    if (error) throw new Error("distance cache write failed", { cause: error });
  }
}
