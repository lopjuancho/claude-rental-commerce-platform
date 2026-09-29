# Rental Commerce Platform

AI-native, multi-tenant commerce platform for party and event rental companies.
First tenant: Tiky Jumps Inflatables LLC (onboarded as data, not code).

- [ARCHITECTURE.md](./ARCHITECTURE.md): system design, security boundaries, AI tool layer, deployment, testing
- [DATABASE.md](./DATABASE.md): schema, RLS strategy, availability engine
- [MVP.md](./MVP.md): Phase 1 scope, milestones, acceptance criteria
- [docs/decisions/](./docs/decisions/README.md): architecture decision records

**Status:** Milestones 1 (foundation, auth, tenancy), 2 (catalog, media, inventory, CSV import), 3 (availability engine, holds, blocks, weather) and 4 (pricing engine, road-distance delivery, configurable tax; outputs for review in [docs/pricing-review.md](./docs/pricing-review.md)) implemented.

## Stack

Next.js 16 · React 19 · TypeScript 6.0 (strict) · Tailwind CSS 4 · shadcn/ui · Supabase (Postgres, Auth, RLS) · Cloudflare Workers via OpenNext · Vitest · Playwright. Exact versions are pinned in `package.json` (see ADR 0005).

## Local development

Requirements: Node 22, pnpm 10, Docker (for the Supabase stack).

```bash
pnpm install
pnpm exec supabase start            # Postgres, Auth, REST on 127.0.0.1:54321 / DB on :54322
pnpm exec supabase db reset         # applies supabase/migrations + supabase/seed.sql
cp .env.example .env.local          # fill keys from `pnpm exec supabase status`
pnpm dev
```

Development tenants from the seed (all passwords `dev-password-123`):

| Tenant | URL | Users |
|---|---|---|
| Acme Party Rentals | http://acme.localhost:3000 | owner@, admin@, office@, staff@acme.test |
| FunTime Rentals | http://funtime.localhost:3000 | owner@funtime.test |
| (both) | — | multi@example.test (org switcher) |

Staff admin: http://localhost:3000/admin

## Checks

```bash
pnpm typecheck         # next typegen + tsc
pnpm lint              # ESLint incl. import-boundary rules (service-role client allow-list)
pnpm format:check
pnpm test              # unit tests (pure domain + server helpers)
pnpm test:integration  # DB tests: RLS isolation matrix, roles, invitations, audit
pnpm build             # Next.js production build
pnpm test:e2e          # Playwright (E2E_START_SERVER=1 starts the built app)
pnpm check             # all of the above except e2e
bash scripts/check-secrets.sh
```

`pnpm test:integration` rebuilds a disposable database with `scripts/test-db.sh` (plain Postgres + a
test-only Supabase auth shim, ADR 0007). Against the Supabase stack instead:
`SKIP_DB_SETUP=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm test:integration`.

## Onboarding a tenant

```bash
DATABASE_URL=postgresql://… node scripts/import-tenant.ts seeds/tenants/<slug> --app-origin=https://…
```

Applies the tenant configuration bundle (settings, categories, domains, policies) idempotently and prints a
one-time owner invitation link. Products are then imported in the admin: Catalog → Import CSV.

## Database changes

Schema changes only via new files in `supabase/migrations/`. Then regenerate types:
`pnpm db:types` (or `DATABASE_URL=… pnpm db:types`). Never edit `src/types/database.ts` by hand.

## Environments

`development` (local Supabase), `staging` and `production` (separate Supabase projects and Cloudflare
Worker environments in `wrangler.jsonc`). Production data is never copied to other environments.
Secrets are set with `wrangler secret put <NAME> --env <env>`, never committed.
