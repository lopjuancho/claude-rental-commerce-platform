# 0016 — Tenant storefront: host-resolved, published-only, authoritative-only

**Status:** Accepted 2026-09-30 · Implemented in M6 (migrations `20261001000100_m6_storefront.sql`,
`20261001000200_m6_review.sql`)

## Decisions

1. **The host is the tenant.** Every storefront route (`/`, `/rentals`, `/rentals/[slug]`,
   `/categories/[slug]`, `/policies/[type]`, `/quote`, `/q/[token]`, `/media/[id]`, `robots.txt`,
   `sitemap.xml`) resolves the organization from the Host header on the server
   (`getRequestTenant`). The browser never supplies an organization id. An unknown host is a 404;
   a slug that is not a published row of *this* tenant is a 404, even if another tenant has it.
2. **Published-only reads through anon-safe views.** The storefront reads with the anonymous
   (publishable-key) client only — never the service role — through explicit-column,
   `security_barrier` views limited to active organizations:
   `public_catalog_categories/products/product_media/variants` (M2),
   `public_storefront_settings`, `public_storefront_policies` (published and not placeholder),
   `public_service_areas` (active names only), and from the review round
   `public_storefront_domains` (verified hostnames only), `public_catalog_category_summaries`
   (published product counts and a cover image per category) and `public_catalog_event_types`.
   Queries filter by the host-resolved tenant, and the pure assemblers drop any row of another
   organization as defence in depth.
3. **Media.** Product images are served by `/media/[id]` for the host's tenant only: the id must be
   in `public_catalog_product_media` (published product, rights not `unverified`), and the object is
   downloaded with the anon client under storage policy `product_media_objects_public_select`,
   which allows exactly those objects. 200s are cacheable (`Vary: Host`), 404s are `no-store`;
   non-image types are served as attachments.
4. **Only authoritative facts.** Nothing is invented: no ratings, reviews, availability, service
   areas or specifications that are not configured. Specs and weather notes are built only from
   configured columns. Structured data: `LocalBusiness` from configured name/contact/address/service
   areas; `BreadcrumbList`; `Product` with an `Offer` only as described in §10. JSON-LD is
   serialized with `<`, `>`, `&` escaped, carries the CSP nonce, and is emitted only when a verified
   canonical origin exists.
5. **SEO** — see §9.
6. **Quote UX reuses the existing server flow.** `/quote?item=<slug>` preselects the product's
   default variant; `?from=<token>` prefills items, the event's current local window and the
   earlier fulfilment (pickup/delivery) from the customer's own quote view. Prefill is convenience
   only: the submission is validated and priced from scratch by the unchanged M5 service. No pricing
   or availability logic runs in the browser.
7. **Next step on the quote page** (`quoteNextStep`), in priority order: confirmed → closed →
   **expired** → **stale** → pending with a live hold → pending awaiting review → request → none.
   An expired or stale quote cannot be confirmed (the database refuses both at confirmation:
   `QUOTE_EXPIRED`, `STALE_BOOKING_REQUEST`), so it asks to recalculate even if a request is still
   pending. Stale shows "Your event details changed, so we need to recalculate availability and
   pricing." with **Update my quote** (`/quote?from=<token>`); expired offers an updated quote.
   `public_quote_view` reports `stale`, and `canRequestBooking` is false for it.
8. **Branding.** Tenant colors become CSS variables (validated `#rrggbb`); the foreground on the
   brand color is chosen by WCAG contrast (`readableOn`). No tenant-specific code or strings.

## Review round (Codex, M6)

9. **Indexing follows the verified request host** (`seoDecision`, pure and unit-tested with
   production inputs). An unverified domain may still resolve the tenant, but:
   - Canonical host = the verified primary domain; without one, the request host only if it is
     itself verified; otherwise there is **no** canonical URL (and no JSON-LD, no absolute share
     URLs). An unverified host is never canonical.
   - `index,follow` only in production, resolved by host, on the canonical host.
   - A **verified alias** is `noindex,follow` with its canonical on the primary; robots.txt on it is
     closed and its sitemap empty.
   - An **unverified host** is `noindex,nofollow`, robots.txt closed, sitemap empty.
   - Local development hosts (`*.localhost`) use http and keep the request port.
10. **Advertised price = what the pricing engine starts from.** The engine prices a variant at
    `coalesce(variant.price_override_cents, product.base_price_cents)`; `public_catalog_variants`
    exposes exactly that (`effective_base_price_cents`) for bookable variants. The storefront shows
    "From <lowest>" everywhere (cards, product page, sticky bar) with the quote qualifier. It shows
    no price if there is no bookable variant or any bookable variant has no price. A `Product` Offer
    is emitted only for a per-event product whose bookable variants all start from the same price —
    never an average, never the product base when an override applies.
11. **Customer-specific pages are private.** Any `/quote` request with a `from` parameter (valid,
    invalid or empty) is `noindex,nofollow`; the canonical is always `/quote` (never a token or a
    preselection). robots.txt disallows `/q/` and `/quote?from=`; the sitemap lists published pages
    only.
12. **No capped lists.** PostgREST caps every response (`max_rows` = 1000 on Supabase), and a short
    page does not prove the end when the cap is below the requested size. So:
    - product detail is a direct tenant-scoped slug lookup, with that product's own media and
      variants; related products are a small category-overlap query;
    - listings (`/rentals`, categories) are server-side pages of 24 with exact counts;
    - category counts, covers and event types come from database views, not from enumerating the
      catalog;
    - anything that must be complete (sitemap slugs, quote options, a product's media/variants) is
      read with `collectPages`: deterministic order by a unique key, requesting pages until an
      EMPTY page, each starting after the rows actually received;
    - quote preselection resolves the product by slug, independently of the option list.
    Tested at the real PostgREST boundary with > 1000 products, variants and media rows.
13. **Image derivatives (L2).** `/media/[id]?w=` accepts only the fixed widths 320/640/960/1280
    (anything else is a 404) and, with `STOREFRONT_IMAGE_TRANSFORMS=on`, serves a width-bounded
    image through Supabase Storage image transformations. Cards and galleries then get a `srcset`,
    with lazy loading kept. Rights and tenant checks are unchanged. **Accepted debt:** the flag is off
    by default because transformations depend on the Supabase plan. Until it is on (or upload-time
    derivatives exist, planned for the media milestone), originals are served and the upload size
    limit (10 MB) bounds them.
14. **Storefront actions never call `redirect()`.** Next renders a server-action redirect target
    through an internal request to its own address, with the visitor's host only in
    `X-Forwarded-Host`. That header is client-controlled and not part of cache keys, so it is never
    trusted for tenant resolution. As a result the target page could not resolve the tenant and
    returned 404 until reload. This affected quote submission and request/renew/cancel booking
    since M5. The actions now return `redirectTo`, and the browser navigates there itself with its
    own Host.

## Not in M6

AI assistant (M7), payments, messaging.
