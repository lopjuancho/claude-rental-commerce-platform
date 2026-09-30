import "server-only";
import {
  normalizeItems,
  prefillFromQuote,
  type QuotePrefill,
} from "@/domain/storefront/quote-prefill";
import { createPublicClient, type PublicClient } from "@/server/db/public";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { getPublicQuote } from "./quotes";
import { listBookableVariants, loadProductBySlug } from "./storefront";

export interface QuoteFormData {
  options: { variantId: string; label: string }[];
  prefill: QuotePrefill;
  /** The form starts from the customer's earlier quote ("stale" when its event changed). */
  from: "stale" | "earlier" | null;
}

/**
 * Everything the storefront quote form needs (ADR 0016 §6, §12). Options are every bookable
 * variant of the tenant (paginated, never a capped list); `item` is resolved by a direct slug
 * lookup, so a product anywhere in a large catalog is preselected. Prefill is a convenience only:
 * the submission is validated and priced from scratch by the quote service.
 */
export async function loadQuoteForm(
  tenant: ResolvedTenant,
  query: { item?: string | null; from?: string | null },
  db: PublicClient = createPublicClient(),
): Promise<QuoteFormData> {
  const [variants, item] = await Promise.all([
    listBookableVariants(tenant, db),
    query.item ? loadProductBySlug(tenant, query.item, db) : Promise.resolve(null),
  ]);
  const options = variants
    .map(({ variantId, label }) => ({ variantId, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.variantId.localeCompare(b.variantId));
  const offered = new Set(options.map((o) => o.variantId));

  let prefill: QuotePrefill = { items: [], event: null };
  let from: QuoteFormData["from"] = null;
  if (query.from) {
    const earlier = await getPublicQuote(tenant, query.from).catch(() => null);
    if (earlier) {
      prefill = prefillFromQuote(earlier, tenant.timezone, offered);
      from = earlier.stale ? "stale" : "earlier";
    }
  }
  if (item?.defaultVariantId && offered.has(item.defaultVariantId)) {
    prefill = {
      ...prefill,
      items: normalizeItems(
        [...prefill.items, { variantId: item.defaultVariantId, quantity: 1 }],
        offered,
      ),
    };
  }
  return { options, prefill, from };
}
