# 0011 — Import adapters map sources onto the canonical product model

**Status:** Accepted 2026-09-28 · Implemented in M2

## Decision

```
source file (ERS CSV, spreadsheet, …)
   ↓  parse (RFC 4180 CSV → header + rows of strings)
   ↓  adapter: detect + suggest a field mapping (source columns → canonical fields, with transforms)
   ↓  staff review/edit of the mapping (saved as a reusable preset)
   ↓  validate against the canonical Zod schemas (same ones the admin UI uses)
   ↓  plan: create / update / skip per row (matched by external_ref, then slug)
   ↓  commit (single transactional database function, audited)
canonical SaaS product model (products, variants, categories)
```

- **The schema never contains source-system column names.** ERS is one adapter; nothing in the tables or services knows ERS exists.
- An adapter is data plus small pure functions: an id, a label, header synonyms per canonical field, and value transforms such as money, yes/no and feet. `src/domain/import/adapters/`.
- The ERS adapter ships with header *guesses* and is marked unverified until tested against a real export. Staff can always correct the mapping, so an adapter mistake costs a click, not a bad import.
- Mapping presets are organization-scoped rows (`import_mapping_presets`), so each tenant can save its own mapping for its own export.
- Re-imports update the same products through `(organization_id, external_source, external_ref)`, never duplicating them.
- Unmapped source columns are kept in `import_rows.raw` for traceability and are never written to products.
