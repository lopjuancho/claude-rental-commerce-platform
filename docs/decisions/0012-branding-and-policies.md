# 0012 — Tenant branding assets and placeholder policies

**Status:** Accepted 2026-09-28

## Branding
Per-organization, all optional (a tenant without branding renders with neutral platform defaults):
- Business display name (`organizations.name`) and legal name.
- Logo, logo mark and favicon: storage paths under `{organization_id}/…` in the public `brand-assets` bucket. Only `settings.write` holders can write them (storage RLS); a CHECK constraint keeps paths inside the organization's prefix.
- Primary, secondary and accent colours (`#rrggbb`, validated in the database and again before reaching a style attribute).

Colours and assets are never inferred. They come from the tenant's uploaded assets. Tenant resolution (`resolve_organization_by_host`) returns the complete public brand profile.

## Policies
Policy records are configurable data (no prose in code). Types: weather, wind_safety, cancellation, overnight, delivery, setup_requirements, power_requirements, water_requirements, supervision, operator_requirements, deposit, safety, other.

- Placeholder records (`is_placeholder = true`) let onboarding create the full checklist before wording exists.
- The database refuses `is_placeholder AND is_published`, so placeholder text can never reach customers or the assistant.
- Editing a placeholder's body clears the flag automatically.
- The tenant bundle inserts a placeholder only when the tenant has no policy of that type, so re-applying a bundle never overwrites real wording.
