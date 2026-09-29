import "server-only";
import { formatAddress, type PostalAddress } from "@/domain/delivery/address";
import type { DistanceProvider, RoadDistanceResult } from "@/domain/delivery/provider";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";

interface RoutesResponse {
  routes?: { distanceMeters?: number }[];
  geocodingResults?: {
    origin?: GeocodedWaypoint;
    destination?: GeocodedWaypoint;
  };
}
interface GeocodedWaypoint {
  geocoderStatus?: { code?: number; message?: string };
  partialMatch?: boolean;
}

/**
 * Google Maps Platform — Routes API (computeRoutes, DRIVE, traffic-unaware) road distance.
 * Only this file knows about Google. Any error maps to a DistanceProvider failure reason, which
 * the delivery resolver turns into manual review; a price is never estimated.
 */
export class GoogleRoutesDistanceProvider implements DistanceProvider {
  readonly id = "google_routes";
  readonly version = "v2-drive-traffic-unaware-1";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  async getRoadDistance(
    origin: PostalAddress,
    destination: PostalAddress,
  ): Promise<RoadDistanceResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          // Only the fields we use (also keeps billing at the Essentials tier).
          "X-Goog-FieldMask": "routes.distanceMeters,geocodingResults",
        },
        body: JSON.stringify({
          origin: { address: formatAddress(origin) },
          destination: { address: formatAddress(destination) },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
          computeAlternativeRoutes: false,
          regionCode: "us",
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, reason: "PROVIDER_ERROR" };
    }

    let body: RoutesResponse & { error?: { status?: string; message?: string } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      return { ok: false, reason: "PROVIDER_ERROR" };
    }

    if (!response.ok) {
      // 400 INVALID_ARGUMENT mentioning a waypoint/address = the address could not be used.
      const message = body.error?.message?.toLowerCase() ?? "";
      if (response.status === 400 && /(address|waypoint|destination)/.test(message))
        return { ok: false, reason: "ADDRESS_NOT_FOUND" };
      return { ok: false, reason: "PROVIDER_ERROR" };
    }

    const origin_ = body.geocodingResults?.origin;
    const dest = body.geocodingResults?.destination;
    if ((origin_?.geocoderStatus?.code ?? 0) !== 0) return { ok: false, reason: "PROVIDER_ERROR" }; // depot address problem: staff must fix settings
    if ((dest?.geocoderStatus?.code ?? 0) !== 0) return { ok: false, reason: "ADDRESS_NOT_FOUND" };
    if (dest?.partialMatch) return { ok: false, reason: "AMBIGUOUS_ADDRESS" };

    const route = body.routes?.[0];
    if (!route) return { ok: false, reason: "NO_ROUTE" };
    const meters = route.distanceMeters ?? 0; // omitted by the API when the distance is zero
    if (!Number.isFinite(meters) || meters < 0) return { ok: false, reason: "PROVIDER_ERROR" };
    return { ok: true, meters };
  }
}
