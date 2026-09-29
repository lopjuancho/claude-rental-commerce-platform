import type { DistanceProvider } from "@/domain/delivery/provider";
import type { RateLimitPolicy } from "@/server/rate-limit/types";
import type { TrustedGateway } from "@/server/trusted/gateway";

/** Caller facts collected by the route/action from the request, never from its body. */
export interface RequestMeta {
  ip: string;
  userAgent?: string;
  requestId?: string;
  /** 'ai' when the assistant acts for the visitor (M7). */
  actor?: "public" | "ai";
}

/** Everything a public service may touch. Injected so tests run the real code against the DB. */
export interface PublicDeps {
  gateway: TrustedGateway;
  rateLimit: (policy: RateLimitPolicy, key: string) => Promise<void>;
  provider: DistanceProvider | null;
}
