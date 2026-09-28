/** Security headers applied to every response by the proxy. Pure so it can be unit-tested. */
export function buildContentSecurityPolicy(opts: {
  nonce: string;
  supabaseUrl: string;
  isDev: boolean;
}): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${opts.nonce}'`,
      "'strict-dynamic'",
      ...(opts.isDev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", opts.supabaseUrl],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", opts.supabaseUrl, ...(opts.isDev ? ["ws:"] : [])],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
  const policy = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!opts.isDev) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "X-Frame-Options": "DENY",
};
