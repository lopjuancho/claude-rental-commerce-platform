/**
 * Normalizes a Host header into the form stored in organization_domains.hostname:
 * lower-case, no port, no trailing dot. Returns null for anything that is not a plausible
 * hostname so garbage never reaches the database.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[")) return null; // IPv6 literals never map to a tenant
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  if (host.includes("..")) return null;
  return host;
}

const SLUG_RE = /^[a-z0-9](-?[a-z0-9])*$/;

export function isValidSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= 63 && SLUG_RE.test(slug);
}
