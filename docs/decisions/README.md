# Architecture Decision Records

One file per significant decision. Status is one of **Proposed**, **Accepted**, **Superseded by NNNN**.
Decision IDs (D1…) refer to the list in `ARCHITECTURE.md` §12.

| ADR | Decision | Status |
|---|---|---|
| [0001](./0001-anonymous-write-path.md) | D1: anonymous visitors write only through a server-side path | Accepted 2026-09-28 |
| [0002](./0002-inventory-holds.md) | D2: draft quotes / 15-minute booking holds / confirmed reservations | Accepted 2026-09-28 |
| [0003](./0003-rental-rules-as-configuration.md) | D3: rental rules are tenant configuration with an override hierarchy | Accepted 2026-09-28 |
| [0004](./0004-tax-engine.md) | D4: location-based tax with per-component taxability | Accepted 2026-09-28 |
| [0005](./0005-typescript-version.md) | D11: pin TypeScript 6.0.x (TS 7 not yet supported by typescript-eslint) | Accepted 2026-09-28 |
| [0006](./0006-inventory-import-and-media-rights.md) | D13: CSV import pipeline; media rights metadata; no cross-tenant media | Accepted 2026-09-28 |
| [0007](./0007-local-db-testing.md) | DB integration tests run against Postgres with a Supabase auth shim when Docker images are unavailable | Accepted 2026-09-28 |
| [0008](./0008-edge-middleware-on-cloudflare.md) | Edge `middleware.ts` instead of Node `proxy.ts` until OpenNext supports it officially | Accepted 2026-09-28 |
