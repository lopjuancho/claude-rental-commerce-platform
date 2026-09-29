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
| [0009](./0009-delivery-distance-pricing.md) | D15: road-distance delivery pricing behind a `DistanceProvider`; manual review instead of guessed fees | Accepted 2026-09-28 |
| [0010](./0010-wind-safety.md) | D16: per-hazard weather rules (wind, lightning, rain, severe weather, temperature, custom); staff-confirmed weather blocks; no automatic cancellations | Accepted 2026-09-28 |
| [0011](./0011-import-adapters.md) | Import adapters map source formats (ERS is one) onto the canonical product model | Accepted 2026-09-28 |
| [0012](./0012-branding-and-policies.md) | Tenant branding assets (logo, mark, favicon, 3 colours) and unpublishable placeholder policies | Accepted 2026-09-28 |
| [0013](./0013-pricing-engine.md) | Deterministic pricing engine: rule precedence, review-first gaps, immutable calculation snapshots with rule revisions | Accepted 2026-09-29 |
| [0014](./0014-hardening-concurrency-trust-boundaries.md) | Hardening: one availability lock protocol for every capacity change; server-only pricing/cache writes; DST-safe local times; a single service-role gateway; CI on claude branches | Accepted 2026-09-30 |
