# 0008 — Edge `middleware.ts` instead of Node.js `proxy.ts` (for now)

**Status:** Accepted 2026-09-28

## Context
Next.js 16 renames `middleware.ts` to `proxy.ts` and runs it on the Node.js runtime. When building for Cloudflare Workers, `@opennextjs/cloudflare` 1.20.6 prints:

> Node.js middleware support is experimental in cloudflare, and not officially maintained by OpenNext maintainers. Use at your own risk.

The legacy `middleware.ts` (edge runtime) is deprecated by Next.js but still fully supported and is the path OpenNext supports officially.

## Decision
Use `src/middleware.ts` (edge runtime). Its responsibilities are deliberately small and use only Web APIs: strip client-supplied internal headers, set request id + CSP nonce, refresh the Supabase session cookie, apply security headers. Authorization never happens in middleware; it happens in server code (`requireStaff`) and in Postgres (RLS).

Consequence: `next build` prints a deprecation notice. Accepted in exchange for a supported production path (production reliability over newest conventions, as for ADR 0005).

## Revisit when
OpenNext for Cloudflare declares Node.js middleware / `proxy.ts` officially supported. The migration is a rename (`npx @next/codemod middleware-to-proxy`).
