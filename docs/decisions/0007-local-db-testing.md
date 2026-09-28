# 0007 — Database integration tests: Supabase stack or Postgres + auth shim

**Status:** Accepted 2026-09-28

## Context
RLS, constraints and race-safety must be tested against real PostgreSQL. The normal path is the Supabase CLI local stack (Docker). Some environments (including the cloud sandbox used to build Milestone 1) cannot pull Supabase container images.

## Decision
DB integration tests (`tests/integration/**`) talk to Postgres directly with the `pg` driver and exercise RLS the same way Supabase does: inside a transaction, `set local role authenticated|anon|service_role` and `set local request.jwt.claims = '{"sub": "...", "role": "..."}'`.

They run against either:
1. **Supabase local stack** (`supabase start`; `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`) — used in CI; or
2. **Plain PostgreSQL 15+** prepared by `scripts/test-db.sh`, which first applies `supabase/tests/shim/supabase_shim.sql` (creates the `anon`, `authenticated`, `service_role` roles, the `auth` schema with `auth.users`, and `auth.uid()` / `auth.jwt()` reading `request.jwt.claims` exactly like Supabase), then all migrations in order.

The shim is test-only and never part of `supabase/migrations`. Migrations must not depend on anything outside what the shim provides plus standard extensions (`pgcrypto`, `btree_gist`, `pg_trgm`, `citext`).

## Consequences
CI remains the authority because it runs on the real Supabase images; the shim path keeps tests runnable when Docker images are unavailable.
