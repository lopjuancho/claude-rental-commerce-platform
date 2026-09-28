import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { buildContentSecurityPolicy, STATIC_SECURITY_HEADERS } from "@/server/security/headers";

/**
 * Runs before every page/API request:
 *  1. strips client-supplied internal headers (tenant/user ids are never taken from the client),
 *  2. assigns a request id and CSP nonce,
 *  3. refreshes the Supabase session cookie,
 *  4. applies security headers.
 * Tenant resolution happens in server code from the Host header (see resolve-tenant.ts).
 */
export async function middleware(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  const isDev = process.env.NODE_ENV === "development";

  const nonce = btoa(crypto.randomUUID());
  const csp = buildContentSecurityPolicy({ nonce, supabaseUrl, isDev });
  const requestId = crypto.randomUUID();

  const requestHeaders = new Headers(request.headers);
  for (const name of [...requestHeaders.keys()]) {
    if (name.startsWith("x-internal-") || name === "x-organization-id" || name === "x-tenant-id") {
      requestHeaders.delete(name);
    }
  }
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("x-internal-pathname", request.nextUrl.pathname);
  requestHeaders.set("content-security-policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  if (supabaseUrl && publishableKey) {
    const supabase = createServerClient(supabaseUrl, publishableKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    });
    // Refreshes an expiring session. Authorization decisions are made later with getUser().
    await supabase.auth.getUser();
  }

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Request-Id", requestId);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS))
    response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)",
  ],
};
