import "server-only";
import { ZodError } from "zod";
import type { Evidence, EvidenceAmount } from "@/domain/assistant/evidence";
import { isDomainError } from "@/domain/errors";
import { AVAILABILITY_REASONS } from "@/domain/availability/reasons";
import { LocalTimeError, localRentalPeriod } from "@/domain/availability/local-time";
import { contactInputSchema } from "@/domain/customers/contact";
import { formatAddress } from "@/domain/delivery/address";
import { formatCents } from "@/domain/money";
import { DELIVERY_REASON_TEXT, explainReviewReason } from "@/domain/pricing/reasons";
import { eventInputSchema, quotePriceRequest } from "@/domain/quotes/schemas";
import type { Product } from "@/domain/storefront/catalog";
import { priceSummary, specGroups, weatherNotes } from "@/domain/storefront/present";
import { quoteNextStep } from "@/domain/storefront/quote-step";
import { createPublicClient } from "@/server/db/public";
import { checkPublicAvailability } from "@/server/public/availability";
import { checkPublicServiceArea } from "@/server/public/delivery";
import { priceForTenant } from "@/server/public/pricing";
import {
  getPublicQuote,
  type PublicQuoteView,
  requestPublicBooking,
  submitQuoteRequest,
} from "@/server/public/quotes";
import { loadProductBySlug, loadShell, searchProducts } from "@/server/public/storefront";
import { generateQuoteToken, hashQuoteToken } from "@/server/quotes/token";
import type {
  AssistantBlock,
  AssistantState,
  Committed,
  MutationRef,
  ProductCardData,
  QuoteBasis,
  StagedItem,
  ToolContext,
  ToolOutcome,
} from "./context";
import {
  MAX_ITEM_QUANTITY,
  MAX_STAGED_ITEMS,
  rememberProducts,
  requestScopedKey,
  ToolError,
} from "./context";
import { DeadlineError } from "./deadline";
import { canonical, sha256Hex } from "./journal";
import {
  FORBIDDEN_ARGUMENT_KEYS,
  MUTATING_TOOLS,
  stripNulls,
  type ToolArgs,
  type ToolName,
  TOOL_NAMES,
  toolSchemas,
} from "./schemas";

/**
 * The assistant's tools (ADR 0017 §3). Each is a thin adapter over an existing trusted service:
 * no pricing, availability, delivery, customer, event, quote or booking rule lives here. Tools get
 * the host-resolved tenant from the context; their arguments were already validated against the
 * strict schemas in `schemas.ts`. Every transactional result is also recorded as typed evidence
 * (grounding), and every business mutation goes through the durable journal (ctx.journal).
 */

const dbOf = (ctx: ToolContext) => ctx.db ?? createPublicClient();
const money = (cents: number, ctx: ToolContext) => formatCents(cents, ctx.tenant.currency);
const at = (ctx: ToolContext) => ctx.now().toISOString();

// ── shared resolution ───────────────────────────────────────────────────────

async function resolveProduct(ctx: ToolContext, slug: string): Promise<Product> {
  const product = await loadProductBySlug(ctx.tenant, slug, dbOf(ctx));
  if (!product) {
    throw new ToolError(
      "NOT_FOUND",
      `There is no published product "${slug}" here. Use search_products to find one.`,
      "rejected_validation",
    );
  }
  rememberProducts(ctx.state, [product.name]);
  return product;
}

function resolveVariant(product: Product, variantId: string | undefined) {
  const variant = variantId
    ? product.variants.find((v) => v.id === variantId)
    : product.variants[0];
  if (!variant) {
    throw new ToolError(
      variantId ? "NOT_FOUND" : "NOT_BOOKABLE",
      variantId
        ? "That option is not offered for this product. Use get_product_details for its options."
        : "This product cannot be booked online right now.",
      variantId ? "rejected_validation" : "rejected_policy",
    );
  }
  return variant;
}

interface WindowArgs {
  date: string;
  startTime: string;
  endTime: string;
  endDate?: string | undefined;
  timeFold?: "earlier" | "later" | undefined;
}

/** DST-safe local window in the business's time zone (the M3/M5 resolver). */
function resolveWindow(ctx: ToolContext, args: WindowArgs) {
  let period: { start: Date; end: Date };
  try {
    period = localRentalPeriod({
      date: args.date,
      startTime: args.startTime,
      endTime: args.endTime,
      ...(args.endDate ? { endDate: args.endDate } : {}),
      timeZone: ctx.tenant.timezone,
      fold: args.timeFold ?? null,
    });
  } catch (e) {
    if (e instanceof LocalTimeError) {
      throw new ToolError(
        e.reason === "AMBIGUOUS" ? "AMBIGUOUS_TIME" : "INVALID_TIME",
        e.reason === "AMBIGUOUS"
          ? "That time happens twice that night (clocks change). Ask which occurrence the customer means."
          : e.message,
        "rejected_validation",
      );
    }
    throw e;
  }
  if (period.start.getTime() <= ctx.now().getTime()) {
    throw new ToolError(
      "PAST_DATE",
      "That date and time have already passed.",
      "rejected_validation",
    );
  }
  return {
    ...period,
    when: whenText(period.start, period.end, ctx.tenant.timezone),
    dates: localDates(period.start, period.end, ctx.tenant.timezone),
  };
}

function whenText(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const sameDay = day.format(start) === day.format(end);
  return sameDay
    ? `${day.format(start)}, ${clock.format(start)} – ${clock.format(end)}`
    : `${day.format(start)} ${clock.format(start)} – ${day.format(end)} ${clock.format(end)}`;
}

/** The local calendar dates a window touches (grounding compares dates named in replies). */
export function localDates(start: Date, end: Date, timeZone: string): string[] {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const out: string[] = [];
  const last = end.getTime() - 1;
  for (let t = start.getTime(); t <= last && out.length < 14; t += 6 * 3_600_000) {
    const k = key.format(new Date(t));
    if (!out.includes(k)) out.push(k);
  }
  const k = key.format(new Date(Math.max(start.getTime(), last)));
  if (!out.includes(k) && out.length < 14) out.push(k);
  return out;
}

function card(product: Product, ctx: ToolContext): ProductCardData {
  const price = priceSummary(product, ctx.tenant.currency);
  const image = product.images[0];
  return {
    slug: product.slug,
    name: product.name,
    url: `/rentals/${product.slug}`,
    image: image ? { url: image.url, alt: image.alt || product.name } : null,
    fromPrice: price ? `${price.prefix} ${price.amount} ${price.unit}` : null,
    shortDescription: product.shortDescription,
  };
}

/** Configured facts only — what the model may cite about a product. */
function facts(product: Product, ctx: ToolContext) {
  const r = product.row;
  const price = priceSummary(product, ctx.tenant.currency);
  return {
    slug: product.slug,
    name: product.name,
    shortDescription: product.shortDescription,
    startingPrice: price
      ? `${price.prefix} ${price.amount} ${price.unit}${price.detail ? ` (${price.detail})` : ""}`
      : "Price is calculated in the quote",
    recommendedCapacity: r.recommended_capacity,
    ages:
      r.minimum_age !== null || r.maximum_age !== null
        ? { min: r.minimum_age, max: r.maximum_age }
        : null,
    wetUse: r.wet_allowed,
    dryUse: r.dry_allowed,
    spaceFeet:
      r.space_length_ft !== null && r.space_width_ft !== null
        ? { length: r.space_length_ft, width: r.space_width_ft, height: r.space_height_ft }
        : null,
    idealEventTypes: product.eventTypes,
    url: `/rentals/${product.slug}`,
  };
}

/** Catalog starting prices ("From $X") as evidence: they back "from/starting at" claims only. */
function catalogEvidence(product: Product, ctx: ToolContext): Evidence {
  const amounts: EvidenceAmount[] = [];
  if (product.startingPriceCents !== null) {
    amounts.push({ role: "starting_price", cents: product.startingPriceCents, label: "from" });
  }
  for (const v of product.variants) {
    if (v.priceCents !== null && v.priceCents > 0) {
      amounts.push({ role: "starting_price", cents: v.priceCents, label: v.name });
    }
  }
  return {
    kind: "catalog_price",
    at: at(ctx),
    productSlug: product.slug,
    productName: product.name,
    currency: ctx.tenant.currency,
    amounts: amounts.slice(0, 20),
  };
}

const itemsText = (items: StagedItem[]) =>
  items.map((i) => ({
    product: i.productName,
    option: i.variantName,
    quantity: i.quantity,
  }));

async function stageItem(
  ctx: ToolContext,
  ref: { productSlug: string; variantId?: string | undefined; quantity: number },
): Promise<StagedItem> {
  const product = await resolveProduct(ctx, ref.productSlug);
  const variant = resolveVariant(product, ref.variantId);
  return {
    variantId: variant.id,
    productSlug: product.slug,
    productName: product.name,
    variantName: product.variants.length > 1 ? variant.name : null,
    quantity: ref.quantity,
  };
}

/**
 * Combines items for the same option. Never clamps or drops anything: a total above the per-item
 * maximum or more distinct items than a quote holds is an explicit refusal.
 */
export function mergeItems(items: StagedItem[]): StagedItem[] {
  const byVariant = new Map<string, StagedItem>();
  for (const i of items) {
    const seen = byVariant.get(i.variantId);
    byVariant.set(i.variantId, seen ? { ...seen, quantity: seen.quantity + i.quantity } : i);
  }
  const merged = [...byVariant.values()];
  const over = merged.filter((i) => i.quantity > MAX_ITEM_QUANTITY);
  if (over.length) {
    throw new ToolError(
      "QUANTITY_LIMIT",
      `The quantity for ${over.map((i) => `${i.productName} (${String(i.quantity)})`).join(", ")} is more than the ${String(MAX_ITEM_QUANTITY)} one quote can hold. Nothing was changed; ask the customer for the quantity they need, or suggest contacting the team for a large order.`,
      "rejected_validation",
      { maxQuantity: MAX_ITEM_QUANTITY },
    );
  }
  if (merged.length > MAX_STAGED_ITEMS) {
    throw new ToolError(
      "TOO_MANY_ITEMS",
      `A quote can hold at most ${String(MAX_STAGED_ITEMS)} different items (this would be ${String(merged.length)}). Nothing was changed; ask the customer which items to keep, or suggest a second quote.`,
      "rejected_validation",
      { maxItems: MAX_STAGED_ITEMS },
    );
  }
  return merged;
}

// ── active quote reconciliation (ADR 0017 §12) ─────────────────────────────

function contactKey(c: NonNullable<AssistantState["contact"]>) {
  return {
    firstName: c.firstName?.trim().toLowerCase() ?? null,
    lastName: c.lastName?.trim().toLowerCase() ?? null,
    email: c.email?.trim().toLowerCase() ?? null,
    phone: c.phone?.replace(/\D/g, "") ?? null,
    emailOptIn: c.emailOptIn ?? null,
    smsOptIn: c.smsOptIn ?? null,
  };
}

/** Hashes of what is staged now: contact, event, items. */
export async function stagedBasis(state: AssistantState): Promise<QuoteBasis> {
  return {
    contact: state.contact ? await sha256Hex(canonical(contactKey(state.contact))) : null,
    event: state.event ? await sha256Hex(canonical(state.event)) : null,
    items: state.items.length
      ? await sha256Hex(
          canonical(
            [...state.items]
              .map((i) => ({ v: i.variantId, q: i.quantity }))
              .sort((a, b) => a.v.localeCompare(b.v)),
          ),
        )
      : null,
  };
}

export type QuoteRelation =
  | { status: "none" }
  | { status: "current" }
  | { status: "mismatched"; changed: ("contact" | "event" | "items")[] };

/**
 * Whether the active quote still matches what the customer has told the assistant since: any
 * change to contact, event (date, time, address, fulfillment, details) or items/quantities makes
 * it "mismatched" — it cannot be booked until an updated quote replaces it.
 */
export async function quoteRelation(state: AssistantState): Promise<QuoteRelation> {
  const q = state.quote;
  if (!q) return { status: "none" };
  const now = await stagedBasis(state);
  const changed = (["contact", "event", "items"] as const).filter((k) => q.basis[k] !== now[k]);
  return changed.length ? { status: "mismatched", changed: [...changed] } : { status: "current" };
}

/**
 * Selects a quote the customer is viewing (its link token was validated for this tenant) as the
 * conversation's active quote. Staged event/items belonged to the previous quote and are cleared;
 * the quote's own event and items are what a booking request uses.
 */
export async function adoptPageQuote(
  state: AssistantState,
  page: { tokenHash: string; quoteNumber: string },
) {
  state.event = undefined;
  state.items = [];
  const basis = await stagedBasis(state);
  state.quote = {
    tokenHash: page.tokenHash,
    quoteNumber: page.quoteNumber,
    origin: "page",
    basis: { contact: basis.contact, event: null, items: null },
  };
}

// ── read-only tools ─────────────────────────────────────────────────────────

async function searchProductsTool(
  ctx: ToolContext,
  args: ToolArgs<"search_products">,
): Promise<ToolOutcome> {
  const shell = await loadShell(ctx.tenant, dbOf(ctx));
  const category = args.categorySlug
    ? shell.categories.find((c) => c.slug === args.categorySlug)
    : undefined;
  if (args.categorySlug && !category) {
    throw new ToolError(
      "NOT_FOUND",
      `No category "${args.categorySlug}". Categories: ${shell.categories.map((c) => c.slug).join(", ") || "none"}.`,
      "rejected_validation",
    );
  }
  const words = (args.query ?? "").toLowerCase();
  const matchingCategories = shell.categories
    .filter((c) =>
      words
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3)
        .some((w) => c.name.toLowerCase().includes(w.replace(/s$/, ""))),
    )
    .map((c) => c.id);
  const products = await searchProducts(
    ctx.tenant,
    {
      query: args.query,
      categoryId: category?.id,
      categoryIdsMatchingQuery: matchingCategories,
      eventType: args.eventType,
      minCapacity: args.minCapacity,
      wet: args.wet,
      limit: args.limit,
    },
    dbOf(ctx),
  );
  rememberProducts(
    ctx.state,
    products.map((p) => p.name),
  );
  return {
    status: "ok",
    result: {
      count: products.length,
      products: products.map((p) => facts(p, ctx)),
      ...(products.length === 0
        ? { note: "No published product matches. Do not suggest products that were not returned." }
        : {}),
    },
    blocks: products.length
      ? [{ type: "products", products: products.map((p) => card(p, ctx)) }]
      : [],
    evidence: products.map((p) => catalogEvidence(p, ctx)),
  };
}

async function productDetailsTool(
  ctx: ToolContext,
  args: ToolArgs<"get_product_details">,
): Promise<ToolOutcome> {
  const product = await resolveProduct(ctx, args.productSlug);
  const shell = await loadShell(ctx.tenant, dbOf(ctx));
  const safetyPolicy = shell.profile.policies.find((p) => /weather|safety/.test(p.type));
  return {
    status: "ok",
    result: {
      ...facts(product, ctx),
      description: product.description,
      specifications: specGroups(product),
      weatherNotes: weatherNotes(product).map((w) => w.text),
      safetyPolicy: safetyPolicy
        ? { title: safetyPolicy.title, url: `/policies/${safetyPolicy.type}` }
        : null,
      options: product.variants.map((v) => ({
        variantId: v.id,
        name: v.name,
        isDefault: v.isDefault,
        startingPrice: v.priceCents !== null && v.priceCents > 0 ? money(v.priceCents, ctx) : null,
      })),
    },
    blocks: [{ type: "products", products: [card(product, ctx)] }],
    evidence: [catalogEvidence(product, ctx)],
  };
}

async function checkAvailabilityTool(
  ctx: ToolContext,
  args: ToolArgs<"check_availability">,
): Promise<ToolOutcome> {
  const product = await resolveProduct(ctx, args.productSlug);
  const variant = resolveVariant(product, args.variantId);
  const window = resolveWindow(ctx, args);
  const result = await checkPublicAvailability(
    ctx.tenant,
    {
      variantId: variant.id,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      quantity: args.quantity,
    },
    ctx.meta,
    ctx.deps.rateLimit,
  );
  // Lead time means "ask the business", not a firm no.
  const status = result.available
    ? "available"
    : result.reasons.includes("OUTSIDE_LEAD_TIME")
      ? "manual_review"
      : "unavailable";
  const reasons = result.reasons.map((r) => AVAILABILITY_REASONS[r]);
  const variantName = product.variants.length > 1 ? variant.name : null;
  return {
    status: status === "manual_review" ? "manual_review" : "ok",
    result: {
      product: product.name,
      option: variantName,
      when: window.when,
      quantity: args.quantity,
      availability: status,
      ...(result.limited ? { note: "Only one or two left for that time." } : {}),
      reasons,
      ...(result.reasons.includes("WEATHER_BLOCK")
        ? { weather: "A weather safety block is in effect. Do not promise the item will operate." }
        : {}),
      reminder: "Availability is not a reservation: nothing is held until request_booking.",
    },
    blocks: [
      {
        type: "availability",
        product: { slug: product.slug, name: product.name, url: `/rentals/${product.slug}` },
        variantName,
        status,
        when: window.when,
        quantity: args.quantity,
        limited: result.limited,
        reasons,
      },
    ],
    evidence: [
      {
        kind: "availability",
        at: at(ctx),
        productSlug: product.slug,
        productName: product.name,
        variantId: variant.id,
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        dates: window.dates,
        quantity: args.quantity,
        result: status,
      },
    ],
  };
}

function priceAmounts(
  lines: { kind: string; amountCents: number; label: string }[],
  taxLines: { name: string; amountCents: number }[],
  subtotal: number,
  total: number,
): EvidenceAmount[] {
  return [
    ...lines.map((l): EvidenceAmount => ({
      role: l.kind === "delivery" ? "delivery" : l.kind === "discount" ? "discount" : "line",
      cents: l.amountCents,
      label: l.label.slice(0, 160),
    })),
    ...taxLines.map((t): EvidenceAmount => ({
      role: "tax",
      cents: t.amountCents,
      label: t.name.slice(0, 160),
    })),
    { role: "subtotal" as const, cents: subtotal, label: "subtotal" },
    { role: "total" as const, cents: total, label: "total" },
  ].slice(0, 60);
}

async function calculatePriceTool(
  ctx: ToolContext,
  args: ToolArgs<"calculate_price">,
): Promise<ToolOutcome> {
  const items = mergeItems(await Promise.all(args.items.map((i) => stageItem(ctx, i))));
  const window = resolveWindow(ctx, args);
  const request = quotePriceRequest({
    items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
    startsAt: window.start.toISOString(),
    endsAt: window.end.toISOString(),
    address: args.address ?? null,
    delivery: args.fulfillment,
    discountCodes: [],
  });
  const run = await priceForTenant(ctx.tenant, request, ctx.meta, { save: false }, ctx.deps);
  const out = run.output;
  const cur = out.currency;
  const subject = canonical({
    items: items.map((i) => [i.variantId, i.quantity]),
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    fulfillment: args.fulfillment,
    address: args.address ?? null,
  }).slice(0, 400);
  const base = {
    kind: "price" as const,
    at: at(ctx),
    subject,
    products: [...new Set(items.map((i) => i.productName))],
    dates: window.dates,
    currency: cur,
    delivery:
      args.fulfillment === "pickup"
        ? ("none" as const)
        : out.delivery.status === "priced"
          ? ("priced" as const)
          : ("manual_review" as const),
  };
  if (out.manualReviewRequired) {
    const reasons = out.reviewReasons.map(explainReviewReason);
    return {
      status: "manual_review",
      result: {
        pricing: "manual_review",
        when: window.when,
        items: itemsText(items),
        reasons,
        instruction:
          "No confirmed price. Tell the customer the team needs to review this before giving a confirmed price. Do not state or estimate any amount.",
      },
      blocks: [
        {
          type: "price",
          status: "manual_review",
          when: window.when,
          fulfillment: args.fulfillment,
          lines: [],
          taxLines: [],
          subtotal: null,
          total: null,
          reasons,
        },
      ],
      evidence: [{ ...base, status: "manual_review", amounts: [] }],
    };
  }
  const lines = out.lines.map((l) => ({ label: l.label, amount: formatCents(l.amountCents, cur) }));
  const taxLines = out.taxLines.map((t) => ({
    label: t.name,
    amount: formatCents(t.amountCents, cur),
  }));
  const subtotal = formatCents(out.summary.subtotal, cur);
  const total = formatCents(out.summary.total, cur);
  return {
    status: "ok",
    result: {
      pricing: "priced",
      when: window.when,
      fulfillment: args.fulfillment,
      items: itemsText(items),
      lines,
      subtotal,
      taxLines,
      total,
      note: "This is a price for these details, not a reservation. A quote records it.",
    },
    blocks: [
      {
        type: "price",
        status: "priced",
        when: window.when,
        fulfillment: args.fulfillment,
        lines,
        taxLines,
        subtotal,
        total,
        reasons: [],
      },
    ],
    evidence: [
      {
        ...base,
        status: "priced",
        amounts: priceAmounts(out.lines, out.taxLines, out.summary.subtotal, out.summary.total),
      },
    ],
  };
}

async function serviceAreaTool(
  ctx: ToolContext,
  args: ToolArgs<"check_service_area">,
): Promise<ToolOutcome> {
  const { address, delivery, currency } = await checkPublicServiceArea(
    ctx.tenant,
    args.address,
    ctx.meta,
    ctx.deps,
  );
  const where = formatAddress(address);
  if (delivery.status === "priced") {
    const fee = formatCents(delivery.feeCents, currency);
    return {
      status: "ok",
      result: {
        serviceArea: "serviceable",
        address: where,
        deliveryFee: fee,
        detail: delivery.label,
      },
      blocks: [
        {
          type: "service_area",
          status: "serviceable",
          address: where,
          fee,
          label: delivery.label,
          reason: null,
        },
      ],
      evidence: [
        {
          kind: "service_area",
          at: at(ctx),
          status: "serviceable",
          currency,
          feeCents: delivery.feeCents,
        },
      ],
    };
  }
  const reasonCode = delivery.status === "manual_review" ? delivery.reason : "NOT_REQUESTED";
  const reason = DELIVERY_REASON_TEXT[reasonCode] ?? "delivery could not be decided automatically";
  const outside = reasonCode === "OUTSIDE_SERVICE_AREA";
  const status = outside ? ("outside_service_area" as const) : ("manual_review" as const);
  return {
    status: "manual_review",
    result: {
      serviceArea: status,
      address: where,
      reason,
      instruction: outside
        ? "The address is outside the configured delivery areas; the team can review special requests."
        : "Delivery could not be confirmed automatically; the team needs to review it.",
    },
    blocks: [
      {
        type: "service_area",
        status,
        address: where,
        fee: null,
        label: null,
        reason,
      },
    ],
    evidence: [{ kind: "service_area", at: at(ctx), status, currency, feeCents: null }],
  };
}

// ── staging tools (no database write) ──────────────────────────────────────

async function quoteChangeNote(ctx: ToolContext) {
  const rel = await quoteRelation(ctx.state);
  return rel.status === "mismatched"
    ? {
        quoteStatus: "out_of_date",
        note: `Quote ${ctx.state.quote?.quoteNumber ?? ""} no longer matches these details (${rel.changed.join(", ")} changed). It cannot be booked; create_quote makes an updated quote.`,
      }
    : {};
}

async function createCustomerTool(
  ctx: ToolContext,
  args: ToolArgs<"create_customer">,
): Promise<ToolOutcome> {
  // Same validation as every public submission; the customer row itself is matched/created by the
  // M5 path inside create_quote, which never overwrites or discloses existing records.
  const parsed = contactInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new ToolError(
      "INVALID_CONTACT",
      parsed.error.issues.map((i) => i.message).join(" "),
      "rejected_validation",
    );
  }
  ctx.state.contact = { ...args };
  return {
    status: "ok",
    result: {
      contact: "saved",
      provided: Object.entries(args)
        .filter(([k]) => !k.endsWith("OptIn"))
        .map(([k]) => k),
      note: "Saved for the quote only. Do not claim an account was created or found.",
      ...(await quoteChangeNote(ctx)),
    },
    blocks: [],
  };
}

async function createEventTool(
  ctx: ToolContext,
  args: ToolArgs<"create_event">,
): Promise<ToolOutcome> {
  const window = resolveWindow(ctx, args);
  const { fulfillment, address, ...rest } = args;
  const input = eventInputSchema.parse({
    ...rest,
    address: fulfillment === "delivery" ? address : null,
  });
  ctx.state.event = { input: { ...input }, fulfillment };
  return {
    status: "ok",
    result: {
      event: "saved",
      when: window.when,
      fulfillment,
      ...(fulfillment === "delivery" && address ? { address: formatAddress(address) } : {}),
      ...(await quoteChangeNote(ctx)),
    },
    blocks: [],
  };
}

// ── quote and booking (the M5 public path, journaled) ──────────────────────

function quoteSummary(ctx: ToolContext, view: PublicQuoteView) {
  const final = view.priceIsFinal;
  return {
    quoteNumber: view.quoteNumber,
    priceIsFinal: final,
    ...(final
      ? {
          total: money(view.totalCents, ctx),
          lines: view.lines.map((l) => ({ label: l.label, amount: money(l.amountCents, ctx) })),
        }
      : {
          instruction:
            "The price needs the team's review before it is final. Do not state an amount.",
        }),
    items: view.items.map((i) => ({ product: i.name, quantity: i.quantity })),
    canRequestBooking: view.canRequestBooking,
    stale: view.stale,
    expired: view.expired,
  };
}

function quoteEvidence(ctx: ToolContext, view: PublicQuoteView): Evidence {
  const start = view.event?.startsAt ?? view.items[0]?.start ?? null;
  const end = view.event?.endsAt ?? view.items[0]?.end ?? null;
  return {
    kind: "quote",
    at: at(ctx),
    quoteNumber: view.quoteNumber,
    products: [...new Set(view.items.map((i) => i.name))].slice(0, 10),
    dates: start && end ? localDates(new Date(start), new Date(end), ctx.tenant.timezone) : [],
    currency: view.currency,
    priceIsFinal: view.priceIsFinal,
    amounts: view.priceIsFinal
      ? priceAmounts(view.lines, view.taxLines, view.subtotalCents, view.totalCents)
      : [],
  };
}

function quoteBlock(
  ctx: ToolContext,
  view: PublicQuoteView,
  token: string | null,
  replaces: string | null,
): AssistantBlock {
  return {
    type: "quote",
    quoteNumber: view.quoteNumber,
    url: token ? `/q/${token}` : null,
    priceIsFinal: view.priceIsFinal,
    total: view.priceIsFinal ? money(view.totalCents, ctx) : null,
    replaces,
  };
}

async function viewOf(ctx: ToolContext, tokenHash: string) {
  return getPublicQuote(ctx.tenant, { tokenHash }, ctx.deps);
}

const OPEN_QUOTE = ["draft", "sent", "viewed"];

function committedQuote(
  ctx: ToolContext,
  view: PublicQuoteView,
  q: {
    tokenHash: string;
    token: string | null;
    quoteId?: string | undefined;
    basis: QuoteBasis;
    staged: Extract<MutationRef, { type: "quote" }>["staged"];
    replaces: string | null;
  },
): Committed {
  return {
    ref: {
      type: "quote",
      tokenHash: q.tokenHash,
      quoteNumber: view.quoteNumber,
      ...(q.quoteId ? { quoteId: q.quoteId } : {}),
      basis: q.basis,
      staged: q.staged,
      replaces: q.replaces,
    },
    outcome: {
      status: view.priceIsFinal ? "ok" : "manual_review",
      result: {
        quote: q.replaces ? "replaced" : "created",
        ...(q.replaces ? { replaces: q.replaces } : {}),
        ...quoteSummary(ctx, view),
      },
      blocks: [quoteBlock(ctx, view, q.token, q.replaces)],
      evidence: [quoteEvidence(ctx, view)],
    },
  };
}

/** Refuses changes to a quote with a booking request in progress (or confirmed/closed). */
async function assertQuoteChangeable(ctx: ToolContext) {
  const q = ctx.state.quote;
  if (!q) return;
  const view = await viewOf(ctx, q.tokenHash);
  if (view && (view.booking?.status === "pending" || view.booking?.status === "confirmed")) {
    throw new ToolError(
      "QUOTE_NOT_EDITABLE",
      `Quote ${q.quoteNumber} has a booking request, so it can no longer be changed here. The team can help with changes.`,
    );
  }
}

/**
 * Makes the staged details the conversation's current quote:
 * - the active quote already matches them (and is still open) → it is returned, nothing is created;
 * - otherwise a new quote is created through the M5 path (journaled, idempotent) and replaces it.
 */
async function quoteFromStaging(ctx: ToolContext, message?: string): Promise<ToolOutcome> {
  const active = ctx.state.quote;
  if (active) {
    const view = await viewOf(ctx, active.tokenHash);
    const rel = await quoteRelation(ctx.state);
    if (
      view &&
      rel.status === "current" &&
      !view.expired &&
      !view.stale &&
      OPEN_QUOTE.includes(view.status)
    ) {
      return {
        status: view.priceIsFinal ? "ok" : "manual_review",
        result: {
          quote: "existing",
          note: "The current quote already matches these details; nothing new was created.",
          ...quoteSummary(ctx, view),
        },
        blocks: [quoteBlock(ctx, view, null, null)],
        evidence: [quoteEvidence(ctx, view)],
      };
    }
  }
  const basis = await stagedBasis(ctx.state);
  return quoteMutation(ctx, "create_quote", ctx.state.items, message, {
    kind: "quote",
    basis,
    message: message ?? null,
    replaces: active?.tokenHash ?? null,
  });
}

/**
 * Creates a quote for the staged contact/event and `items` through the journal. The state's
 * staging changes only when the mutation is committed (or replayed): the reference carries it.
 */
async function quoteMutation(
  ctx: ToolContext,
  toolName: "create_quote" | "add_quote_item",
  items: StagedItem[],
  message: string | undefined,
  key: unknown,
): Promise<ToolOutcome> {
  const missing = [
    ...(ctx.state.contact ? [] : ["contact details (create_customer)"]),
    ...(ctx.state.event ? [] : ["event date/time and pickup or delivery (create_event)"]),
    ...(items.length ? [] : ["at least one item"]),
  ];
  if (missing.length) {
    throw new ToolError(
      "MISSING_DETAILS",
      `Still needed: ${missing.join("; ")}.`,
      "rejected_validation",
    );
  }
  const { contact, event } = ctx.state as Required<AssistantState>;
  const basis = await stagedBasis({ ...ctx.state, items });
  const staged = { contact, event, items };
  const replaces = ctx.state.quote?.quoteNumber ?? null;
  const token = generateQuoteToken();
  const tokenHash = await hashQuoteToken(token);
  const { outcome } = await ctx.journal.run({
    toolName,
    key,
    pending: { tokenHash },
    recover: async (pending) => {
      const earlier = pending?.tokenHash;
      if (!earlier) return null;
      const view = await viewOf(ctx, earlier);
      return view
        ? committedQuote(ctx, view, { tokenHash: earlier, token: null, basis, staged, replaces })
        : null;
    },
    perform: async () => {
      const created = await submitQuoteRequest(
        ctx.tenant,
        {
          contact,
          event: event.input,
          items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
          delivery: event.fulfillment,
          ...(message ? { message } : {}),
        },
        ctx.meta,
        ctx.deps,
        { token },
      );
      const view = await viewOf(ctx, tokenHash);
      if (!view) throw new Error("created quote not readable");
      return committedQuote(ctx, view, {
        tokenHash,
        token,
        quoteId: created.quoteId,
        basis,
        staged,
        replaces,
      });
    },
  });
  return outcome;
}

async function createQuoteTool(
  ctx: ToolContext,
  args: ToolArgs<"create_quote">,
): Promise<ToolOutcome> {
  if (args.items) {
    const items = mergeItems(await Promise.all(args.items.map((i) => stageItem(ctx, i))));
    await assertQuoteChangeable(ctx);
    ctx.state.items = items;
  }
  return quoteFromStaging(ctx, args.message);
}

async function addQuoteItemTool(
  ctx: ToolContext,
  args: ToolArgs<"add_quote_item">,
): Promise<ToolOutcome> {
  const item = await stageItem(ctx, args);
  const items = mergeItems([...ctx.state.items, item]);
  await assertQuoteChangeable(ctx);
  const active = ctx.state.quote;
  if (!active) {
    ctx.state.items = items;
    return {
      status: "ok",
      result: {
        staged: "added",
        items: itemsText(items),
        note: "Not a quote yet. create_quote will price these items.",
      },
      blocks: [],
    };
  }
  // Snapshots are immutable: an updated quote is a new, fully re-priced quote (M5 path). "Add one
  // more" depends on when it is asked, so its key is the customer request + occurrence: a retry of
  // the same message replays it instead of adding the item a second time.
  return quoteMutation(
    ctx,
    "add_quote_item",
    items,
    undefined,
    // Only request-stable parts: after a failed attempt the state already points at the quote it
    // made, so anything derived from the state would change the key on retry.
    requestScopedKey(ctx, "add_quote_item", { variantId: item.variantId, quantity: item.quantity }),
  );
}

const BOOKING_TEXT = {
  awaiting_review: "The booking request was received; the team will confirm it.",
  confirmed: "This booking is confirmed by the team.",
  stale:
    "The event details changed after pricing, so availability and price must be recalculated first.",
  expired: "This quote has expired. Availability and price must be checked again with a new quote.",
  needs_review: "The price needs the team's review before a booking can be requested.",
  unavailable: "The items are no longer available for that time.",
  hold_limit:
    "This browser already has the maximum number of bookings on hold. One must finish or expire first.",
  needs_page_reload:
    "Please reload the page once and ask again (the browser session was not found).",
  closed: "This quote is closed.",
} as const;

function holdMinutes(ctx: ToolContext, holdExpiresAt: string) {
  return Math.max(1, Math.round((Date.parse(holdExpiresAt) - ctx.now().getTime()) / 60_000));
}

function clockText(ctx: ToolContext, iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: ctx.tenant.timezone,
  }).format(new Date(iso));
}

function committedBooking(
  ctx: ToolContext,
  quote: { tokenHash: string; quoteNumber: string },
  view: PublicQuoteView,
  holdExpiresAt: string,
): Committed {
  const minutes = holdMinutes(ctx, holdExpiresAt);
  const message =
    `Your booking request has been submitted and the inventory is being held for ${String(minutes)} minutes.` +
    (view.priceIsFinal
      ? ""
      : " The price still needs the team's review before the team confirms the booking.");
  return {
    ref: {
      type: "booking",
      tokenHash: quote.tokenHash,
      quoteNumber: quote.quoteNumber,
      holdExpiresAt,
    },
    outcome: {
      status: "ok",
      result: {
        booking: "hold_placed",
        quoteNumber: quote.quoteNumber,
        holdMinutes: minutes,
        holdExpiresAt,
        priceIsFinal: view.priceIsFinal,
        message,
        instruction:
          "Use exactly this message. The booking is NOT confirmed: the team confirms it. Never say it is booked or paid.",
      },
      blocks: [
        {
          type: "booking",
          status: "hold_placed",
          quoteNumber: quote.quoteNumber,
          holdExpiresAt,
          message,
        },
      ],
      evidence: [
        {
          kind: "booking",
          at: at(ctx),
          quoteNumber: quote.quoteNumber,
          status: "hold_placed",
          holdExpiresAt,
          message,
        },
      ],
    },
  };
}

const sameNumber = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

async function requestBookingTool(
  ctx: ToolContext,
  args: ToolArgs<"request_booking">,
): Promise<ToolOutcome> {
  // 1. Exactly one intended quote.
  const page = ctx.pageQuote ?? null;
  if (args.quoteNumber) {
    if (page && sameNumber(args.quoteNumber, page.quoteNumber)) {
      await adoptPageQuote(ctx.state, page);
      ctx.pageQuote = null;
    } else if (!ctx.state.quote || !sameNumber(args.quoteNumber, ctx.state.quote.quoteNumber)) {
      throw new ToolError(
        "UNKNOWN_QUOTE",
        `Quote ${args.quoteNumber} is not one this conversation can book${ctx.state.quote ? ` (this chat's quote is ${ctx.state.quote.quoteNumber}${page ? `; the customer is viewing ${page.quoteNumber}` : ""})` : ""}.`,
        "rejected_validation",
      );
    }
  } else if (page && ctx.state.quote) {
    throw new ToolError(
      "AMBIGUOUS_QUOTE",
      `The customer is viewing quote ${page.quoteNumber}, but this chat's quote is ${ctx.state.quote.quoteNumber}. Ask which quote to request the booking for, then call request_booking with that quoteNumber.`,
      "rejected_validation",
      { viewing: page.quoteNumber, chat: ctx.state.quote.quoteNumber },
    );
  }
  const quote = ctx.state.quote;
  if (!quote) {
    throw new ToolError(
      "NO_QUOTE",
      "There is no quote in this conversation yet. Create one first (create_customer, create_event, create_quote).",
      "rejected_validation",
    );
  }
  // 2. The quote must still match what the customer asked for since.
  const rel = await quoteRelation(ctx.state);
  if (rel.status === "mismatched") {
    throw new ToolError(
      "DETAILS_CHANGED",
      `The ${rel.changed.join(", ")} changed after quote ${quote.quoteNumber} was made, so it cannot be booked. Call create_quote to make an updated quote first.`,
      "rejected_policy",
      { changed: rel.changed },
    );
  }
  const quoteNumber = quote.quoteNumber;
  const refuse = (
    status: keyof typeof BOOKING_TEXT,
    extra: Record<string, unknown> = {},
  ): ToolOutcome => ({
    status: "rejected_policy",
    errorCode: status.toUpperCase(),
    result: { booking: status, quoteNumber, message: BOOKING_TEXT[status], ...extra },
    blocks: [
      { type: "booking", status, quoteNumber, holdExpiresAt: null, message: BOOKING_TEXT[status] },
    ],
    evidence: [
      {
        kind: "booking",
        at: at(ctx),
        quoteNumber,
        status: status === "confirmed" ? "confirmed" : "refused",
        holdExpiresAt: null,
        message: BOOKING_TEXT[status],
      },
    ],
  });
  const holding = (until: string): ToolOutcome => {
    const message = `A booking request for quote ${quoteNumber} is already in progress; the items are held until ${clockText(ctx, until)}.`;
    return {
      status: "rejected_policy",
      errorCode: "HOLDING",
      result: { booking: "holding", quoteNumber, holdExpiresAt: until, message },
      blocks: [{ type: "booking", status: "holding", quoteNumber, holdExpiresAt: until, message }],
      evidence: [
        {
          kind: "booking",
          at: at(ctx),
          quoteNumber,
          status: "holding",
          holdExpiresAt: until,
          message,
        },
      ],
    };
  };

  // The request is journaled under this customer request: a retry of the same message replays
  // its outcome (before any state check), a new message asks the database again.
  try {
    const { outcome } = await ctx.journal.run({
      toolName: "request_booking",
      key: requestScopedKey(ctx, "request_booking", { tokenHash: quote.tokenHash }),
      pending: null,
      recover: async () => {
        const now = await viewOf(ctx, quote.tokenHash);
        const b = now?.booking;
        return now && b?.status === "pending" && b.holdActive && b.holdExpiresAt
          ? committedBooking(ctx, quote, now, b.holdExpiresAt)
          : null;
      },
      perform: async () => {
        const view = await viewOf(ctx, quote.tokenHash);
        if (!view) throw new ToolError("NOT_FOUND", "The quote could not be found.");
        // The quote's state must allow a request (the database enforces the same).
        const step = quoteNextStep(view);
        const refusal: Record<string, keyof typeof BOOKING_TEXT> = {
          confirmed: "confirmed",
          closed: "closed",
          stale: "stale",
          expired: "expired",
          awaiting_review: "awaiting_review",
          none: "needs_review",
        };
        const refused = refusal[step.kind];
        if (refused) throw new BookingRefusal(refuse(refused));
        if (step.kind === "holding") throw new BookingRefusal(holding(step.until));
        const hold = await requestPublicBooking(
          ctx.tenant,
          { tokenHash: quote.tokenHash },
          args.message ? { message: args.message } : {},
          ctx.meta,
          ctx.deps,
        );
        return committedBooking(ctx, quote, view, hold.holdExpiresAt);
      },
    });
    return outcome;
  } catch (e) {
    if (e instanceof BookingRefusal) return e.outcome;
    const code = (e as { code?: string }).code;
    if (code === "PUBLIC_HOLD_LIMIT") return refuse("hold_limit");
    if (code === "INSUFFICIENT_AVAILABILITY" || code === "BLOCKED") return refuse("unavailable");
    if (code === "STALE_BOOKING_REQUEST") return refuse("stale");
    if (code === "QUOTE_EXPIRED") return refuse("expired");
    if (code === "REVIEW_REQUIRED") return refuse("needs_review");
    if (code === "INVALID_INPUT" && !ctx.meta.visitorToken) return refuse("needs_page_reload");
    throw e;
  }
}

/** A refusal decided before anything was written (the journal marks the attempt failed). */
class BookingRefusal extends ToolError {
  constructor(readonly outcome: ToolOutcome) {
    super(outcome.errorCode ?? "REFUSED", "booking refused");
  }
}

// ── registry ───────────────────────────────────────────────────────────────

type Impl<N extends ToolName> = (
  ctx: ToolContext,
  args: ToolArgs<N>,
) => Promise<ToolOutcome> | ToolOutcome;

export const TOOL_IMPLEMENTATIONS: { [N in ToolName]: Impl<N> } = {
  search_products: searchProductsTool,
  get_product_details: productDetailsTool,
  check_availability: checkAvailabilityTool,
  calculate_price: calculatePriceTool,
  check_service_area: serviceAreaTool,
  create_customer: createCustomerTool,
  create_event: createEventTool,
  create_quote: createQuoteTool,
  add_quote_item: addQuoteItemTool,
  request_booking: requestBookingTool,
};

// ── execution: the only way a model's request becomes a tool call ──────────

const isToolName = (name: string): name is ToolName => (TOOL_NAMES as string[]).includes(name);

/** Finds forbidden keys at any depth (tenant/price/status injection attempts). */
export function forbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${String(i)}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k;
    return [
      ...((FORBIDDEN_ARGUMENT_KEYS as readonly string[]).includes(k) ? [here] : []),
      ...forbiddenKeys(v, here),
    ];
  });
}

const issuesOf = (e: ZodError) =>
  e.issues.slice(0, 6).map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`);

/**
 * Validates and runs one tool call. Never throws: every failure becomes an outcome the model can
 * explain (validation/policy) or a neutral error (system), with a stable code for telemetry.
 * Unexpected errors are reported through `onError` (server log with the correlation id) and never
 * reach the model or the customer. (The turn records the outcome's evidence in the state.)
 *
 * Deadline: no tool starts after the turn's deadline; read-only tools stop waiting at it. Mutating
 * tools are not cut off mid-flight — the journal refuses to START a mutation after the deadline,
 * and a mutation already running completes and is recorded.
 */
export async function executeTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
  onError: (e: unknown) => void = () => undefined,
): Promise<ToolOutcome> {
  const reject = (
    status: "rejected_validation" | "rejected_policy" | "error",
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): ToolOutcome => ({
    status,
    errorCode: code,
    result: { error: code, message, ...extra },
    blocks: [],
  });

  if (!isToolName(name)) return reject("rejected_policy", "UNKNOWN_TOOL", "No such tool.");
  let raw: unknown;
  try {
    // Strict provider schemas send null for omitted optional arguments.
    raw = stripNulls(rawArguments.trim() === "" ? {} : JSON.parse(rawArguments));
  } catch {
    return reject("rejected_validation", "INVALID_ARGUMENTS", "Arguments must be a JSON object.");
  }
  const forbidden = forbiddenKeys(raw);
  if (forbidden.length) {
    return reject(
      "rejected_policy",
      "FORBIDDEN_ARGUMENT",
      "The business, prices, statuses and record ids are decided by the system and cannot be supplied.",
      { fields: forbidden },
    );
  }
  const parsed = toolSchemas[name].safeParse(raw);
  if (!parsed.success) {
    return reject(
      "rejected_validation",
      "INVALID_ARGUMENTS",
      "Some details are missing or invalid.",
      {
        issues: issuesOf(parsed.error),
      },
    );
  }
  if (ctx.deadline.expired()) {
    return reject(
      "error",
      "TURN_DEADLINE",
      "Out of time for this message; nothing was checked or changed. Try again.",
    );
  }
  try {
    const impl = TOOL_IMPLEMENTATIONS[name] as (
      c: ToolContext,
      a: unknown,
    ) => Promise<ToolOutcome> | ToolOutcome;
    const run = Promise.resolve(impl(ctx, parsed.data));
    return MUTATING_TOOLS.has(name) ? await run : await ctx.deadline.race(run, name);
  } catch (e) {
    if (e instanceof DeadlineError) {
      return reject("error", "TURN_DEADLINE", "That check took too long. Try again.");
    }
    if (e instanceof ToolError) return reject(e.status, e.code, e.message, e.details ?? {});
    if (e instanceof ZodError) {
      return reject(
        "rejected_validation",
        "INVALID_ARGUMENTS",
        "Some details are missing or invalid.",
        {
          issues: issuesOf(e),
        },
      );
    }
    if (isDomainError(e)) {
      if (e.code === "RATE_LIMITED")
        return reject(
          "error",
          "RATE_LIMITED",
          "Too many requests right now. Try again in a minute.",
        );
      if (e.code === "NOT_FOUND") return reject("rejected_validation", "NOT_FOUND", "Not found.");
      if (e.code === "INVALID_INPUT")
        return reject("rejected_validation", "INVALID_INPUT", e.message);
      if (e.code !== "INTERNAL") return reject("rejected_policy", e.code, e.message);
    }
    onError(e);
    return reject(
      "error",
      "TOOL_FAILED",
      "That check could not be completed right now. Try again.",
    );
  }
}
