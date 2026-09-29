/**
 * Anonymous visitor identity for public booking limits (ADR 0015 §14–15). Pure helpers, safe to
 * import from middleware.
 *
 * - A server-issued opaque token: 256 random bits, base64url. It carries no PII and means nothing
 *   by itself; the browser keeps it in an HttpOnly cookie.
 * - Only its SHA-256 (domain-separated from quote-link hashes) is ever sent to the database, which
 *   uses it to cap concurrent live public holds per visitor per organization.
 * - It is not a login and not a customer identity: emails and IPs are never used in its place.
 * - It is issued by storefront page views (middleware), never by booking actions, so simultaneous
 *   first-use actions cannot each mint an identity.
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

/** Storefront pages (GET/HEAD) establish the visitor identity; nothing else issues it. */
export function shouldIssueVisitorCookie(method: string, pathname: string, current: unknown) {
  const storefront =
    pathname === "/" ||
    pathname === "/quote" ||
    pathname.startsWith("/quote/") ||
    pathname.startsWith("/q/");
  return (
    (method === "GET" || method === "HEAD") && storefront && !isWellFormedVisitorToken(current)
  );
}
