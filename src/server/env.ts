import "server-only";
import { z } from "zod";

const hostnameRe = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export const serverEnvSchema = z
  .object({
    APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    /** Platform domain for tenant subdomains, e.g. "rentals.example.com" (decision D7). */
    PLATFORM_ROOT_DOMAIN: z.string().regex(hostnameRe).optional(),
    /** Development-only: tenant used when the host does not map to one. Forbidden in production. */
    DEV_TENANT_SLUG: z.string().optional(),
    APP_ORIGIN: z.url().optional(),
    /** Google Maps Platform key (Routes API). Server-only secret; restrict it to the Routes API. */
    GOOGLE_MAPS_API_KEY: z.string().min(20).optional(),
    /**
     * Storefront image derivatives via Supabase Storage image transformations (ADR 0016 §13).
     * "on" only where the project has transformations enabled; otherwise originals are served.
     */
    STOREFRONT_IMAGE_TRANSFORMS: z.enum(["on", "off"]).default("off"),
    /** Server-side only secret for the assistant's model provider (ADR 0017 §9). */
    OPENAI_API_KEY: z.string().min(20).optional(),
    /**
     * Assistant model provider: "openai" (needs OPENAI_API_KEY), "scripted" (deterministic test
     * double, never in production) or "off". Unset = "openai" when a key is present, else off.
     */
    AI_PROVIDER: z.enum(["openai", "scripted", "off"]).optional(),
    /** Model id and budgets (defaults in src/server/ai/config.ts). */
    AI_MODEL: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,80}$/)
      .optional(),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(4000).optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === "production" && env.DEV_TENANT_SLUG) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_TENANT_SLUG"],
        message: "must not be set in production",
      });
    }
    if (env.APP_ENV === "production" && env.AI_PROVIDER === "scripted") {
      ctx.addIssue({
        code: "custom",
        path: ["AI_PROVIDER"],
        message: "the scripted test provider is not allowed in production",
      });
    }
    if (env.AI_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "required for AI_PROVIDER=openai",
      });
    }
    if (env.APP_ENV !== "development" && env.NEXT_PUBLIC_SUPABASE_URL.startsWith("http://")) {
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_SUPABASE_URL"],
        message: "must use https outside development",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Parses configuration; throws with the names (never the values) of invalid variables. Empty
 * values (a bare `NAME=` copied from .env.example) count as unset.
 */
export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const set = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ""));
  const result = serverEnvSchema.safeParse(set);
  if (!result.success) {
    const fields = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server configuration — ${fields}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
