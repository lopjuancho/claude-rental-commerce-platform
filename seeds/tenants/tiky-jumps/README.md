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
| Display name | Tiky Jumps | `organization.name` |
| Domains | tikyjumps.com (primary), www.tikyjumps.com | `domains` |
| Website | https://www.tikyjumps.com | `settings.websiteUrl` |
| Phone / SMS | 901-300-0417 / 901-250-8127 (stored as E.164) | `settings.contactPhone`, `smsPhone` |
| Timezone | America/Chicago (Memphis market) | `organization.timezone` |
| Buffers | 60 min setup, 60 min teardown/pickup | `settings` |
| Lead time / hold | 12 h / 15 min | `settings` |
| Water slides | up to 4 h standard window | category `water-slides` |
| Delivery | first 5 road miles free, $4/mi after, one-way road distance (Google Maps Routes), rounded up | `settings.mileage` |
| Depot (delivery origin) | 2560 Overton Crossing St, Memphis TN 38127 | `settings.primaryDepot` |
| Additional days | +25 % of base rental per additional day (approved 2026-09-30) | `pricingRules` |
| Multi-day billing | rolling 24 h: Fri 5 PM → Sun noon = 2 days (approved 2026-09-30) | `settings.multiDayBilling` |
| Inflatable wind limit | 15 mph on Bounce Houses, Water Slides, Combos, Interactives | category `weather` rules |
| Trackless trains | not wind sensitive | category `trackless-trains` rule |

Overnight and extra-hour charges are supported by the pricing engine but deliberately **not configured**: until Tiky Jumps provides amounts, such rentals return `manual_review` instead of an invented price.

## Deliberately left unset (do not fill from assumptions)

- **Owner email**: unset until provided.
- **Maximum delivery distance**: unset (no maximum). With no service areas configured, mileage applies to any routable address; configure service areas or a maximum to restrict the delivery region.
- **Overnight charge, extra-hour rates, attendant rates**: unset (→ manual review when needed).
- **Tax**: no jurisdictions configured (→ manual review) until the production Tennessee treatment is confirmed.
- **Branding**: logo, logo mark, favicon and primary/secondary/accent colors come from Tiky Jumps' own assets once uploaded.
- **Tents, foam equipment**: no weather rule yet (the inflatable 15 mph rule does NOT apply). Add rules once manufacturer/operational requirements are confirmed.
- **Mechanical/special attractions**: configure product-level weather and operator requirements per item.
- **Policies**: ten placeholder records (weather, wind safety, cancellation, overnight, delivery, setup, power, water, supervision, operator/attendant). They are unpublished and the database refuses to publish a placeholder; they are never shown to customers or the assistant until real wording is entered.
- **ERS adapter**: stays unverified until a real export sample is provided.
