# 0001 — Anonymous visitors write only through a server-side path (D1)

**Status:** Accepted 2026-09-28

## Context
Anonymous storefront visitors and the AI assistant acting for them need to create customer leads, event drafts, conversations, quote drafts and temporary booking requests. They have no Supabase user.

## Decision
- Anonymous visitors have **no direct write access** to any tenant table. The `anon` Postgres role gets no `INSERT/UPDATE/DELETE` grants and no write policies on tenant tables.
- All anonymous writes go through server-side route handlers / server actions → services in `src/server/public/**`, which use the **system context** (service-role client) or `SECURITY DEFINER` functions.
- The organization is **always** resolved server-side from the request host via `organization_domains` (custom domain or platform subdomain). Any `organization_id` in a request body, query string or header set by the browser is ignored. Services in `src/server/public/**` accept an `OrgContext` produced by the tenancy module, never a raw id from input.
- Every public write path has: Zod input validation, rate limiting (per org + IP/visitor key), and an audit entry (`actor_type = 'public'` or `'ai'`) for state-changing actions (lead created, quote draft created, booking requested).
- Permitted anonymous writes: customer lead/contact, event draft, conversation + messages, quote draft, temporary booking request. Nothing else.

## Consequences
- The service-role key is confined to `src/server/db/system.ts`; ESLint restricts which modules may import it, and integration tests assert that system-context repositories reject rows whose `organization_id` differs from the context.
- Supabase anonymous sign-ins stay disabled (`enable_anonymous_sign_ins = false`) until a customer portal is designed.
