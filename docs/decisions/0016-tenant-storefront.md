# 0016 — Tenant storefront: host-resolved, published-only, authoritative-only

**Status:** Accepted 2026-09-30 · Implemented in M6 (migration `20261001000100_m6_storefront.sql`)

## Decisions

1. **The host is the tenant.** Every storefront route (`/`, `/rentals`, `/rentals/[slug]`,
   `/categories/[slug]`, `/policies/[type]`, `/quote`, `/q/[token]`, `/media/[id]`, `robots.txt`,
   `sitemap.xml`) resolves the organization from the Host header on the server
   (`getRequestTenant`). The browser never supplies an organization id. An unknown host is a 404;
   a slug that is not a published row of *this* tenant is a 404, even if another tenant has it.
2. **Published-only reads through anon-safe views.** The storefront reads with the anonymous
   (publishable-key) client only — never the service role — through explicit-column,
   `security_barrier` views limited to active organizations:
   `public_catalog_categories/products/product_media/variants` (M2) and, new in M6,
   `public_storefront_settings` (address, delivery radius figures, *verified* primary hostname),
   `public_storefront_policies` (published and not placeholder) and `public_service_areas`
   (active area names only; no pricing internals). Queries filter by the host-resolved tenant, and
   `assembleStorefront` drops any row of another organization as defence in depth.
3. **Media.** Product images are served by `/media/[id]` for the host's tenant only: the id must be
   in `public_catalog_product_media` (published product, rights not `unverified`), and the object is
   downloaded with the anon client under storage policy `product_media_objects_public_select`,
   which allows exactly those objects. Responses are cacheable (`Vary: Host`); non-image types are
   served as attachments.
4. **Only authoritative facts.** Nothing is invented: no ratings, reviews, availability, service
   areas or specifications that are not configured. Prices show only a configured, positive base
   rate with its unit and the qualifier "Base rate. Delivery, tax and options are calculated in
   your quote." Specs and weather notes are built only from configured columns. Structured data:
   `LocalBusiness` from configured name/contact/address/service areas; `Product` with an `Offer`
   only for a per-event base price (never `availability`); `BreadcrumbList`. JSON-LD is serialized
   with `<`, `>`, `&` escaped and carries the CSP nonce.
5. **SEO.** Canonical origin = the verified primary domain (https), else the request host
   (`canonicalOrigin`). Only production hosts resolved by host are indexable; everything else is
   `noindex` with `robots.txt` disallowing all and an empty sitemap. `/q/`, `/admin`, `/api/`,
   `/auth/` are never crawlable.
6. **Quote UX reuses the existing server flow.** `/quote?item=<slug>` preselects the product's
   default variant; `?from=<token>` prefills items and the event's current local window from the
   customer's own quote view. Prefill is convenience only: the submission is validated and priced
   from scratch by the unchanged M5 service. No pricing or availability logic runs in the browser.
7. **Stale quotes.** `public_quote_view` reports `stale` (open quote whose event changed after
   pricing — `app.quote_event_mismatch`) and `canRequestBooking` is false for it. The page's next
   step (`quoteNextStep`) shows "Your event details changed, so we need to recalculate availability
   and pricing." with **Update my quote** (`/quote?from=<token>`) instead of Request booking. A
   request already with the team keeps its hold controls; expired quotes offer an updated quote.
8. **Branding.** Tenant colors become CSS variables (validated `#rrggbb`); the foreground on the
   brand color is chosen by WCAG contrast (`readableOn`). No tenant-specific code or strings.

## Not in M6

AI assistant (M7), payments, messaging.
