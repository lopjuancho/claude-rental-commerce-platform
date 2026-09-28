# Tiky Jumps tenant bundle

Configuration data only; no application code references Tiky Jumps. Applied with:

```bash
DATABASE_URL=… node scripts/import-tenant.ts seeds/tenants/tiky-jumps --app-origin=https://…
```

Products come from the CSV import in the admin (ERS export → mapping → preview → commit).
Photos and brand assets are uploaded in the admin with their usage rights recorded (ADR 0006); none are stored here.

## Confirmed by the product owner (2026-09-28)

| Item | Value | Where |
|---|---|---|
| Legal name | Tiky Jumps Inflatables LLC | `organization.legalName` |
| Domains | tikyjumps.com (primary), www.tikyjumps.com | `domains` |
| Website | https://www.tikyjumps.com | `settings.websiteUrl` |
| Phone / SMS | 901-300-0417 / 901-250-8127 (stored as E.164) | `settings.contactPhone`, `smsPhone` |
| Timezone | America/Chicago (Memphis market) | `organization.timezone` |
| Buffers | 60 min setup, 60 min teardown/pickup | `settings` |
| Lead time / hold | 12 h / 15 min | `settings` |
| Water slides | up to 4 h standard window | category `water-slides` |
| Delivery | first 5 road miles free, $4/mi after, one-way, rounded up | `settings.mileage` |
| Inflatable wind limit | 15 mph on Bounce Houses, Water Slides, Combos, Interactives | category `weather` rules |
| Trackless trains | not wind sensitive | category `trackless-trains` rule |

Business rules that belong to pricing (overnight next-day pickup, +25 % per additional day) are configured with the pricing engine in M4.

## Deliberately left unset (do not fill from assumptions)

- **Display name**: set to "Tiky Jumps" (short form of the legal name). Please confirm.
- **Owner email**: unset until provided.
- **Depot / operational origin address**: unset until provided. Mileage delivery returns manual review until then.
- **Maximum delivery distance**: unset (no maximum; out-of-area/uncertain → manual review).
- **Branding**: logo, logo mark, favicon and primary/secondary/accent colors come from Tiky Jumps' own assets once uploaded.
- **Tents, foam equipment**: no weather rule yet (the inflatable 15 mph rule does NOT apply). Add rules once manufacturer/operational requirements are confirmed.
- **Mechanical/special attractions**: configure product-level weather and operator requirements per item.
- **Policies**: ten placeholder records (weather, wind safety, cancellation, overnight, delivery, setup, power, water, supervision, operator/attendant). They are unpublished and the database refuses to publish a placeholder; they are never shown to customers or the assistant until real wording is entered.
- **ERS adapter**: stays unverified until a real export sample is provided.
