import "server-only";
import type { DistanceProvider } from "@/domain/delivery/provider";
import { getServerEnv } from "@/server/env";
import { GoogleRoutesDistanceProvider } from "./providers/google-routes";

/** The configured road-distance provider, or null (→ delivery needs manual review). */
export function getDistanceProvider(): DistanceProvider | null {
  const key = getServerEnv().GOOGLE_MAPS_API_KEY;
  return key ? new GoogleRoutesDistanceProvider(key) : null;
}
