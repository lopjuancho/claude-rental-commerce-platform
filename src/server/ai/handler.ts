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
import { publicBlock } from "./journal";
import { AI_LIMITS, getAiConfig } from "./config";
import { createProvider } from "./providers";
import {
  currentSession,
  generateSessionToken,
  hashSessionToken,
  nextGeneration,
  sessionCookieName,
  sessionCookieOptions,
  sessionCookies,
} from "./session";
import { logAssistantError } from "./telemetry";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
const bodySchema = z.strictObject({
  message: z.string().max(AI_LIMITS.maxMessageChars),
  /** Client id of this message: a retry of the same message sends the same id. */
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  page: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("product"), slug }),
      z.strictObject({ kind: z.literal("category"), slug }),
      z.strictObject({ kind: z.literal("quote"), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      z.strictObject({ kind: z.literal("other") }),
    ])
    .optional(),
});

export const MAX_BODY_BYTES = 8 * 1024;
const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, errorCode: string, reply: string) =>
  NextResponse.json(
    { status: "error", errorCode, reply, blocks: [] },
    { status, headers: noStore },
  );

/**
 * Reads at most `max` bytes of the body, stopping (and cancelling the stream) as soon as it is
 * exceeded — a missing or forged Content-Length cannot make the server buffer more.
 */
export async function readBodyCapped(
  request: Request,
  max: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

async function limited(policy: "assistant" | "assistantSession", key: string) {
  try {
    await enforceRateLimit(policy, key);
    return null;
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
}

/**
 * POST /api/assistant (ADR 0017). Tenant from the Host header; the browser sends only its message,
 * a per-message request id and page context. Every request — including malformed, oversized and
 * wrong-type ones — spends the per-IP budget BEFORE the body is read; the body is read with a hard
 * byte ceiling; the per-session budget applies once the session is known.
 */
export async function handleAssistantPost(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const config = getAiConfig();
  const tenant = await getRequestTenant();
  if (!config || !tenant) return fail(404, "NOT_FOUND", "Not found.");
  const ip = await getClientIp();
  const early = await limited("assistant", `${tenant.organizationId}:${ip}`);
  if (early) {
    await request.body?.cancel().catch(() => undefined);
    return early;
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await request.body?.cancel().catch(() => undefined);
    return fail(415, "UNSUPPORTED", "Send JSON.");
  }
  const raw = await readBodyCapped(request, MAX_BODY_BYTES);
  if (!raw.ok) return fail(413, "TOO_LARGE", "That message is too long.");
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse(raw.text));
  } catch {
    return fail(
      400,
      "INVALID_MESSAGE",
      `Please send a message of up to ${String(AI_LIMITS.maxMessageChars)} characters.`,
    );
  }

  const correlationId = (await getRequestId()) ?? crypto.randomUUID();
  const jar = await cookies();
  // The session must exist BEFORE a message can change anything (ADR 0017 §11): it is issued by
  // storefront page views, the bootstrap GET and New Chat — never by this mutation-capable POST,
  // whose response (and Set-Cookie) could be lost after a quote was created.
  // The session in effect is the highest generation present (session.ts): a stale, older
  // cookie written late by a slow response can never redirect this message.
  const sessionToken = currentSession(jar.getAll())?.token;
  if (!sessionToken) {
    return fail(409, "SESSION_REQUIRED", "Please reload the page to start the assistant.");
  }
  const perSession = await limited(
    "assistantSession",
    `${tenant.organizationId}:${await hashSessionToken(sessionToken)}`,
  );
  if (perSession) return perSession;

  let result;
  try {
    const visitorToken = await readVisitorToken();
    result = await runTurn(
      {
        tenant,
        sessionToken,
        requestKey: body.requestId,
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
        startedAt,
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
  const status = result.errorCode === "IN_PROGRESS" || result.errorCode === "BUSY" ? 409 : 200;
  return NextResponse.json(
    { ...result, blocks: result.blocks.map(publicBlock), correlationId },
    { status, headers: noStore },
  );
}

/**
 * Issues a new session generation (bootstrap or New Chat) and expires the superseded ones this
 * request carried. The generation orders sessions independently of response arrival order.
 */
function issueSession(
  request: Request,
  response: NextResponse,
  all: { name: string; value: string }[],
) {
  const generation = nextGeneration(all, new URL(request.url).searchParams.get("g"));
  const secure = process.env.NODE_ENV === "production";
  for (const old of sessionCookies(all)) {
    if (old.generation < generation)
      response.cookies.set(old.name, "", { ...sessionCookieOptions(secure), maxAge: 0 });
  }
  response.cookies.set(
    sessionCookieName(generation),
    generateSessionToken(),
    sessionCookieOptions(secure),
  );
}

/**
 * GET /api/assistant — session bootstrap: issues a session if this browser has none. It runs
 * nothing, so a lost response costs nothing; the POST that follows reads it. Its cookie carries a
 * generation (session.ts), so if it arrives AFTER a New Chat it cannot replace that newer session.
 */
export async function handleAssistantGet(request: Request): Promise<Response> {
  const config = getAiConfig();
  const tenant = await getRequestTenant();
  if (!config || !tenant) return fail(404, "NOT_FOUND", "Not found.");
  const all = (await cookies()).getAll();
  const response = new NextResponse(null, { status: 204, headers: noStore });
  if (!currentSession(all)) issueSession(request, response, all);
  return response;
}

/**
 * DELETE /api/assistant — "New chat": replaces this browser's session with a fresh one of a
 * HIGHER generation. The old conversation is not reachable from the browser any more; neither a
 * reply still in flight for it (POST responses never set the session cookie) nor a late bootstrap
 * or page response (a lower generation) can bring an older session back.
 */
export async function handleAssistantDelete(request: Request): Promise<Response> {
  const response = new NextResponse(null, { status: 204, headers: noStore });
  issueSession(request, response, (await cookies()).getAll());
  return response;
}
