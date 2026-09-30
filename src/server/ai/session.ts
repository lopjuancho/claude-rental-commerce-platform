/**
 * Anonymous assistant sessions (ADR 0017 §6): an opaque 256-bit random token in an HttpOnly
 * cookie. It carries no data; the database stores only its SHA-256, scoped to the organization.
 */
export const AI_SESSION_COOKIE = "rc_ai";
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
