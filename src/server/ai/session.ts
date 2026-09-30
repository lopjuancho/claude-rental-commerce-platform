/**
 * Anonymous assistant sessions (ADR 0017 §6): an opaque 256-bit random token in an HttpOnly
 * cookie. It carries no data; the database stores only its SHA-256, scoped to the organization.
 *
 * Session GENERATIONS (ADR 0017 §15). A browser applies Set-Cookie in the order responses ARRIVE,
 * so a slow response issued earlier (a bootstrap GET, a page prefetch) could otherwise overwrite
 * the session a later New Chat established — and the next message would silently go to another
 * conversation. So every issuance writes a cookie NAMED after its generation (`rc_ai` = 0,
 * `rc_ai_<n>`), and the session in effect is always the highest generation present: a late,
 * older write lands under a lower name and changes nothing, whatever the arrival order.
 * - page views issue generation 0 (only when the browser has no session at all);
 * - the bootstrap GET and New Chat (DELETE) issue max(highest present + 1, the client's requested
 *   generation): the widget numbers its own bootstrap/reset requests, so two requests sent from
 *   the same cookie state are still ordered as they were SENT.
 * Superseded generations are expired by the next bootstrap/reset response.
 */
export const AI_SESSION_COOKIE = "rc_ai";
export const MAX_SESSION_GENERATION = 999_999_999;
const SESSION_COOKIE_NAME = /^rc_ai(?:_([1-9]\d{0,8}))?$/;

export const sessionCookieName = (generation: number) =>
  generation === 0 ? AI_SESSION_COOKIE : `${AI_SESSION_COOKIE}_${String(generation)}`;

export interface SessionCookie {
  name: string;
  generation: number;
  token: string;
}

/** Well-formed session cookies, newest generation first. */
export function sessionCookies(all: { name: string; value: string }[]): SessionCookie[] {
  const out: SessionCookie[] = [];
  for (const c of all) {
    const m = SESSION_COOKIE_NAME.exec(c.name);
    if (!m || !isWellFormedSessionToken(c.value)) continue;
    out.push({ name: c.name, generation: m[1] ? Number(m[1]) : 0, token: c.value });
  }
  return out.sort((a, b) => b.generation - a.generation);
}

/** The session in effect: the highest generation present. */
export const currentSession = (all: { name: string; value: string }[]): SessionCookie | null =>
  sessionCookies(all)[0] ?? null;

/** The generation a bootstrap/reset issues (see above). */
export function nextGeneration(
  all: { name: string; value: string }[],
  requested: string | null,
): number {
  const highest = currentSession(all)?.generation ?? 0;
  const asked = requested && /^\d{1,9}$/.test(requested) ? Number(requested) : 0;
  return Math.min(MAX_SESSION_GENERATION, Math.max(highest + 1, asked, 1));
}
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const isWellFormedSessionToken = (value: unknown): value is string =>
  typeof value === "string" && TOKEN.test(value);

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ai:${token}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}
