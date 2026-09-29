import "server-only";
import { cookies } from "next/headers";

/**
 * Anonymous visitor identity for public booking limits (ADR 0015 §14).
 *
 * - A server-issued opaque token: 256 random bits, base64url. It carries no PII and means nothing
 *   by itself; the browser keeps it in an HttpOnly cookie.
 * - Only its SHA-256 (domain-separated from quote-link hashes) is ever sent to the database, which
 *   uses it to cap concurrent live public holds per visitor per organization.
 * - It is not a login and not a customer identity: emails and IPs are never used in its place.
 */
export const VISITOR_COOKIE = "rc_visitor";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
const HASH_DOMAIN = "rental-commerce:visitor:v1:";

export function generateVisitorToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export const isWellFormedVisitorToken = (token: unknown): token is string =>
  typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);

export async function hashVisitorToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(HASH_DOMAIN + token),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function visitorCookieOptions(production: boolean) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax" as const,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}

/**
 * The current visitor's token: the cookie's when well-formed, otherwise a fresh one that is set on
 * the response. A malformed cookie is replaced, never trusted or echoed back.
 * Call only from a server action or route handler (it may set a cookie).
 */
export async function getOrIssueVisitorToken(): Promise<string> {
  const jar = await cookies();
  const current = jar.get(VISITOR_COOKIE)?.value;
  if (isWellFormedVisitorToken(current)) return current;
  const token = generateVisitorToken();
  jar.set(VISITOR_COOKIE, token, visitorCookieOptions(process.env.NODE_ENV === "production"));
  return token;
}
