# Pricing review: Tiky Jumps configuration

> **Generated** by `tests/integration/pricing-review.test.ts` from the real pricing engine and the real
> Tiky Jumps tenant bundle (`seeds/tenants/tiky-jumps/tenant.json`). Do not edit by hand. The test fails
> if this file drifts from what the engine produces. Regenerate with
> `WRITE_PRICING_REVIEW=1 pnpm test:integration tests/integration/pricing-review.test.ts`.

**Product prices are illustrative** (Tiky Jumps' real prices will come from the ERS import).
**Road distances are simulated**; production uses Google Maps (Routes API, one-way driving distance
from 2560 Overton Crossing St, Memphis TN 38127). Events are on Saturday, June 19, 2027 (America/Chicago).

Configuration in effect: water slides include 4 hours; +25 % of base per additional day; first 5 road
miles free, then $4/mile rounded up; overnight **not enabled** and no overnight charge; no extra-hour,
attendant or tax configuration. Wherever configuration is missing the engine returns
`manual_review_required: true` with a reason. It never invents a price.

Until Tiky Jumps' Tennessee tax rules are entered, **every** price below requires tax review
(`TAX_JURISDICTION_UNRESOLVED`); the last scenario shows how taxable and non-taxable components
behave, using an obviously fake test rate.

### Water slide, 4 hours (the included window), 3.0 mi delivery

| Line | Taxable | Amount |
|---|---|---:|
| Example Water Slide | ? | $450.00 |
| Delivery (3 mi, within 5 free miles) | ? | $0.00 |
| **Subtotal** | | **$450.00** |
| **Total** | | **$450.00** |

**Manual review required** (the total above is provisional):
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 45000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 0,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 45000,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 45000,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### Delivery exactly 5.0 mi → $0

| Line | Taxable | Amount |
|---|---|---:|
| Example Water Slide | ? | $450.00 |
| Delivery (5 mi, within 5 free miles) | ? | $0.00 |
| **Subtotal** | | **$450.00** |
| **Total** | | **$450.00** |

**Manual review required** (the total above is provisional):
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 45000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 0,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 45000,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 45000,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### Delivery 5.1 mi → 1 billable mile

| Line | Taxable | Amount |
|---|---|---:|
| Example Water Slide | ? | $450.00 |
| Delivery (5.1 mi: 1 billable mi × $4.00) | ? | $4.00 |
| **Subtotal** | | **$454.00** |
| **Total** | | **$454.00** |

**Manual review required** (the total above is provisional):
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 45000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 400,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 45400,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 45400,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### Delivery 8.2 mi → ceil(8.2 − 5) = 4 mi × $4 = $16

| Line | Taxable | Amount |
|---|---|---:|
| Example Water Slide | ? | $450.00 |
| Delivery (8.2 mi: 4 billable mi × $4.00) | ? | $16.00 |
| **Subtotal** | | **$466.00** |
| **Total** | | **$466.00** |

**Manual review required** (the total above is provisional):
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 45000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 1600,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 46600,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 46600,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### Water slide, 5 hours (1 hour beyond the included 4)

_No extra-hour rate is configured for Tiky Jumps yet, so the engine refuses to guess._

| Line | Taxable | Amount |
|---|---|---:|
| Example Water Slide | ? | $450.00 |
| Delivery (8.2 mi: 4 billable mi × $4.00) | ? | $16.00 |
| **Subtotal** | | **$466.00** |
| **Total** | | **$466.00** |

**Manual review required** (the total above is provisional):
- `EXTRA_HOURS_PRICING_NOT_CONFIGURED:L1`: The rental is longer than the included duration and no extra-time rate is configured.
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 45000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 1600,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 46600,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 46600,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### Water slide overnight (Sat 6 PM → Sun 10 AM)

_Overnight is not enabled and no overnight charge is configured, so the price needs review._

| Line | Taxable | Amount |
|---|---|---:|
| Example Water Slide | ? | $450.00 |
| Delivery (8.2 mi: 4 billable mi × $4.00) | ? | $16.00 |
| **Subtotal** | | **$466.00** |
| **Total** | | **$466.00** |

**Manual review required** (the total above is provisional):
- `OVERNIGHT_NOT_PERMITTED:L1`: The rental runs overnight, which is not permitted for this item.
- `OVERNIGHT_PRICING_NOT_CONFIGURED:L1`: The rental runs overnight and no overnight charge is configured.
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 45000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 1600,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 46600,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 46600,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### Bounce house, Friday 5 PM → Sunday 12 PM (43 h = 2 billable days)

| Line | Taxable | Amount |
|---|---|---:|
| Example Bounce House | ? | $175.00 |
| Example Bounce House: 1 additional day | ? | $43.75 |
| Delivery (8.2 mi: 4 billable mi × $4.00) | ? | $16.00 |
| **Subtotal** | | **$234.75** |
| **Total** | | **$234.75** |

**Manual review required** (the total above is provisional):
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 17500,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 4375,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 1600,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 23475,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 23475,
    "manual_review_required": true
  },
  "appliedRules": [
    {
      "type": "additional_day",
      "name": "Additional day (+25% of base per day)",
      "revision": 1
    }
  ]
}
```
</details>

### Bounce house, 3 days (Fri 10 AM → Mon 9 AM)

| Line | Taxable | Amount |
|---|---|---:|
| Example Bounce House | ? | $175.00 |
| Example Bounce House: 2 additional days | ? | $87.50 |
| Delivery (8.2 mi: 4 billable mi × $4.00) | ? | $16.00 |
| **Subtotal** | | **$278.50** |
| **Total** | | **$278.50** |

**Manual review required** (the total above is provisional):
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 17500,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 8750,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 1600,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 27850,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 27850,
    "manual_review_required": true
  },
  "appliedRules": [
    {
      "type": "additional_day",
      "name": "Additional day (+25% of base per day)",
      "revision": 1
    }
  ]
}
```
</details>

### Quantities: 2 bounce houses + 100 chairs, 4 hours

| Line | Taxable | Amount |
|---|---|---:|
| Example Bounce House × 2 | ? | $350.00 |
| Example Folding Chair × 100 | ? | $250.00 |
| Delivery (8.2 mi: 4 billable mi × $4.00) | ? | $16.00 |
| **Subtotal** | | **$616.00** |
| **Total** | | **$616.00** |

**Manual review required** (the total above is provisional):
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 60000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 102,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 1600,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 61600,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 61600,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### Customer pickup (no delivery)

| Line | Taxable | Amount |
|---|---|---:|
| Example Bounce House | ? | $175.00 |
| **Subtotal** | | **$175.00** |
| **Total** | | **$175.00** |

**Manual review required** (the total above is provisional):
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 17500,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 0,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 17500,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 17500,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### Map service failure

_Delivery is never estimated: the whole price is marked for review._

| Line | Taxable | Amount |
|---|---|---:|
| Example Water Slide | ? | $450.00 |
| **Subtotal** | | **$450.00** |
| **Total** | | **$450.00** |

**Manual review required** (the total above is provisional):
- `DELIVERY:PROVIDER_ERROR`: Delivery could not be priced automatically: the map service did not answer.
- `TAX_JURISDICTION_UNRESOLVED`: No tax jurisdiction is configured for this location.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 45000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 0,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 45000,
    "taxable_subtotal": 0,
    "tax": 0,
    "total": 45000,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>

### With an EXAMPLE test tax configuration (9.25 %, rentals taxable, delivery not)

_Illustrates taxable vs non-taxable components only. These are NOT Tennessee production rules; test configurations always require review._

| Line | Taxable | Amount |
|---|---|---:|
| Example Water Slide | yes | $450.00 |
| Delivery (8.2 mi: 4 billable mi × $4.00) | no | $16.00 |
| **Subtotal** | | **$466.00** |
| EXAMPLE test rate (9.25 % of $450.00) | | $41.63 |
| **Total** | | **$507.63** |

**Manual review required** (the total above is provisional):
- `TAX_TEST_CONFIGURATION`: Tax was calculated with TEST rates, not verified production rules.

<details><summary>Structured output</summary>

```json
{
  "summary": {
    "base": 45000,
    "extra_hours": 0,
    "overnight": 0,
    "additional_days": 0,
    "quantity": 1,
    "add_ons": 0,
    "labor": 0,
    "fees": 0,
    "delivery": 1600,
    "discounts": 0,
    "adjustments": 0,
    "subtotal": 46600,
    "taxable_subtotal": 45000,
    "tax": 4163,
    "total": 50763,
    "manual_review_required": true
  },
  "appliedRules": []
}
```
</details>
