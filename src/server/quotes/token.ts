/**
 * Customer quote links. The token is 256 random bits shown once (in the link); only its SHA-256
 * is stored, so a database read never reveals a working link.
 */
export function generateQuoteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export const isWellFormedQuoteToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);

export async function hashQuoteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
