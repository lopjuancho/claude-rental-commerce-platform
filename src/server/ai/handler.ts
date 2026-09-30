import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isDomainError } from "@/domain/errors";
import { getDistanceProvider } from "@/server/delivery/provider";
import { enforceRateLimit } from "@/server/rate-limit";
import { getClientIp, getRequestId } from "@/server/request";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";
import { systemAiStore, systemGateway } from "@/server/trusted/gateway";
import { readVisitorToken } from "@/server/visitor";
import { runTurn } from "./assistant";
import { AI_LIMITS, getAiConfig } from "./config";
import { createProvider } from "./providers";
import {
  AI_SESSION_COOKIE,
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  sessionCookieOptions,
} from "./session";
import { logAssistantError } from "./telemetry";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
const bodySchema = z.strictObject({
  message: z.string().max(AI_LIMITS.maxMessageChars),
  page: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("product"), slug }),
      z.strictObject({ kind: z.literal("category"), slug }),
      z.strictObject({ kind: z.literal("quote"), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      z.strictObject({ kind: z.literal("other") }),
    ])
    .optional(),
});

const MAX_BODY_BYTES = 8 * 1024;
const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, errorCode: string, reply: string) =>
  NextResponse.json(
    { status: "error", errorCode, reply, blocks: [] },
    { status, headers: noStore },
  );

/**
 * POST /api/assistant (ADR 0017). Tenant from the Host header; the browser sends only its message
 * and page context. Rate-limited per IP and per session; the session is an opaque HttpOnly cookie.
 */
export async function handleAssistantPost(request: Request): Promise<Response> {
  const config = getAiConfig();
  const tenant = await getRequestTenant();
  if (!config || !tenant) return fail(404, "NOT_FOUND", "Not found.");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail(415, "UNSUPPORTED", "Send JSON.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return fail(413, "TOO_LARGE", "That message is too long.");
  }
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse(raw));
  } catch {
    return fail(
      400,
      "INVALID_MESSAGE",
      `Please send a message of up to ${String(AI_LIMITS.maxMessageChars)} characters.`,
    );
  }

  const ip = await getClientIp();
  const correlationId = (await getRequestId()) ?? crypto.randomUUID();
  const jar = await cookies();
  const existing = jar.get(AI_SESSION_COOKIE)?.value;
  const sessionToken = isWellFormedSessionToken(existing) ? existing : generateSessionToken();
  try {
    await enforceRateLimit("assistant", `${tenant.organizationId}:${ip}`);
    await enforceRateLimit(
      "assistantSession",
      `${tenant.organizationId}:${await hashSessionToken(sessionToken)}`,
    );
  } catch (e) {
    if (isDomainError(e) && e.code === "RATE_LIMITED") {
      return fail(
        429,
        "RATE_LIMITED",
        "You're sending messages quickly. Please wait a moment and try again.",
      );
    }
    throw e;
  }

  let result;
  try {
    const visitorToken = await readVisitorToken();
    result = await runTurn(
      {
        tenant,
        sessionToken,
        message: body.message,
        page: body.page,
        meta: {
          ip,
          ...(request.headers.get("user-agent")
            ? { userAgent: request.headers.get("user-agent") ?? "" }
            : {}),
          ...(visitorToken ? { visitorToken } : {}),
        },
        correlationId,
      },
      {
        provider: createProvider(config),
        store: systemAiStore(),
        publicDeps: {
          gateway: systemGateway(),
          rateLimit: enforceRateLimit,
          provider: getDistanceProvider(),
        },
        maxOutputTokens: config.maxOutputTokens,
      },
    );
  } catch (e) {
    logAssistantError(correlationId, "turn", e);
    return fail(
      503,
      "AI_UNAVAILABLE",
      "The assistant is unavailable right now. You can keep browsing or try again in a moment.",
    );
  }
  const response = NextResponse.json({ ...result, correlationId }, { headers: noStore });
  if (sessionToken !== existing) {
    response.cookies.set(
      AI_SESSION_COOKIE,
      sessionToken,
      sessionCookieOptions(process.env.NODE_ENV === "production"),
    );
  }
  return response;
}

/** DELETE /api/assistant — "New chat": forget this browser's conversation cookie. */
export function handleAssistantDelete(): Response {
  const response = new NextResponse(null, { status: 204, headers: noStore });
  response.cookies.set(AI_SESSION_COOKIE, "", {
    ...sessionCookieOptions(process.env.NODE_ENV === "production"),
    maxAge: 0,
  });
  return response;
}
