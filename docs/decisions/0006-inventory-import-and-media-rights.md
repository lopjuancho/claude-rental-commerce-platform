# 0006 — CSV-first inventory import and media rights (D13)

**Status:** Accepted 2026-09-28

## Import
Tiky Jumps' inventory lives in Event Rental Systems (ERS). The import pipeline is CSV-first and generic (no ERS-specific code in core; an ERS column-mapping preset is data):

```
CSV upload (ERS export or spreadsheet)
  → import_batches (status: uploaded)          raw file kept in private storage
  → parse into import_rows (raw jsonb)          status: parsed
  → field mapping (column → product field)      saved as a reusable mapping preset
  → validation (same Zod schemas as admin UI)   per-row errors/warnings, status: validated
  → preview (create / update / skip per row)    staff reviews
  → commit (idempotent upsert by org + slug/external_ref)   status: committed, audit logged
```

- Manual product creation in admin uses the same validation schemas.
- `products.external_ref` + `external_source` (e.g. `ers`) allow re-imports to update rather than duplicate.
- Imports are organization-scoped like everything else; a batch can only write to its own organization.

## Media rights
- Only media the organization owns, is licensed to use, or supplier/manufacturer media whose terms allow reuse may be imported or uploaded. Images scraped from an existing website are **not** assumed redistributable.
- `product_media` stores: `organization_id`, `uploaded_by`, `source` (`upload`, `import`, `supplier`), `original_filename`, `rights_status` (`owned`, `licensed`, `supplier_permitted`, `unverified`), `rights_notes`.
- Media with `rights_status = 'unverified'` can be stored and used in admin but **cannot be published** to the storefront (DB check on the public view + UI warning).
- Each organization owns and is responsible for the media it uploads. Media is never copied between organizations: storage paths are prefixed with `organization_id`, storage RLS enforces the prefix, and the importer rejects sources outside the target organization. Tiky Jumps photos never appear in another tenant's account, and platform demo/seed data uses its own placeholder media.
