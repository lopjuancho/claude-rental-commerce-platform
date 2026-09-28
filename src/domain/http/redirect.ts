/**
 * Only same-origin relative paths are allowed as post-login redirect targets (prevents open
 * redirects such as `//evil.com` or `/\evil.com`).
 */
export function safeRedirectPath(value: unknown, fallback = "/admin"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\\]/.test(value)) return fallback;
  return value;
}
