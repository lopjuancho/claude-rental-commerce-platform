# Tiky Jumps tenant bundle

Configuration data only — no code references Tiky Jumps. Applied with:

```bash
DATABASE_URL=… node scripts/import-tenant.ts seeds/tenants/tiky-jumps --app-origin=https://…
```

Products come from the CSV import in the admin (ERS export → mapping → preview → commit).
Photos are uploaded per product with their usage rights recorded (ADR 0006); none are stored here.

## Confirmed (from product owner, 2026-09-28)
- Timezone America/Chicago (Memphis market); setup/pickup buffers 60/60 min; lead time 12 h; booking hold 15 min.
- Water slides: 4-hour standard window. Wind threshold 15 mph for wind-sensitive inflatables.
- Delivery: first 5 road miles free, then $4/mile, one-way from the depot, rounded up to the next mile.

## Still to fill in before going live
- `ownerEmail`, `domains` (custom domain + platform subdomain), branding colours/logo, phone/SMS/email/website.
- `settings.primaryDepot` address and `settings.mileage.maximumMiles`.
- Whether Tents (and trains/foam) are wind sensitive — left unset (= not sensitive) until confirmed.
- Multi-day pricing (+25 %/day), overnight rules and tax configuration arrive with the pricing engine (M4).
- Published policies (weather, cancellation, deposit, delivery, safety) — exact wording.
