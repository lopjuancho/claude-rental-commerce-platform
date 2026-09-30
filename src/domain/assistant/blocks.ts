/**
 * Assistant UI blocks (ADR 0017 §4): built by the SERVER from tool results — never by the model —
 * and rendered by the chat component. Shared types only.
 */

export interface ProductCardData {
  slug: string;
  name: string;
  url: string;
  image: { url: string; alt: string } | null;
  /** "From $175 per event" — the storefront's starting price, or null. */
  fromPrice: string | null;
  shortDescription: string | null;
}

export type AssistantBlock =
  | { type: "products"; products: ProductCardData[] }
  | {
      type: "availability";
      product: { slug: string; name: string; url: string };
      variantName: string | null;
      status: "available" | "unavailable" | "manual_review";
      when: string;
      quantity: number;
      limited: boolean;
      reasons: string[];
    }
  | {
      type: "price";
      status: "priced" | "manual_review";
      when: string;
      fulfillment: "delivery" | "pickup";
      lines: { label: string; amount: string }[];
      taxLines: { label: string; amount: string }[];
      subtotal: string | null;
      total: string | null;
      reasons: string[];
    }
  | {
      type: "service_area";
      status: "serviceable" | "outside_service_area" | "manual_review";
      address: string;
      fee: string | null;
      label: string | null;
      reason: string | null;
    }
  | {
      type: "quote";
      quoteNumber: string;
      /** The private quote link: only in the turn that created the quote (never stored). */
      url: string | null;
      priceIsFinal: boolean;
      total: string | null;
      replaces: string | null;
    }
  | {
      type: "booking";
      status:
        | "hold_placed"
        | "holding"
        | "awaiting_review"
        | "confirmed"
        | "stale"
        | "expired"
        | "needs_review"
        | "unavailable"
        | "hold_limit"
        | "needs_page_reload"
        | "closed";
      quoteNumber: string;
      holdExpiresAt: string | null;
      message: string;
    };
