import "server-only";
import { headers } from "next/headers";

/** Client IP as seen by Cloudflare. Used only as a rate-limit key, never for authorization. */
export async function getClientIp(): Promise<string> {
  const h = await headers();
  return h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Path of the current request, set by the middleware (client-supplied values are stripped). */
export async function getRequestPathname(): Promise<string | undefined> {
  return (await headers()).get("x-internal-pathname") ?? undefined;
}

export async function getRequestId(): Promise<string | undefined> {
  return (await headers()).get("x-request-id") ?? undefined;
}
