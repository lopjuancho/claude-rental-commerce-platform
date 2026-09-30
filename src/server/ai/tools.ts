import "server-only";
import { ZodError } from "zod";
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
import { hashQuoteToken } from "@/server/quotes/token";
import type {
  AssistantBlock,
  ProductCardData,
  StagedItem,
  ToolContext,
  ToolOutcome,
} from "./context";
import { ToolError } from "./context";
import {
  FORBIDDEN_ARGUMENT_KEYS,
  type ToolArgs,
  type ToolName,
  TOOL_NAMES,
  toolSchemas,
} from "./schemas";

/**
 * The assistant's tools (ADR 0017 §3). Each is a thin adapter over an existing trusted service:
 * no pricing, availability, delivery, customer, event, quote or booking rule lives here. Tools get
 * the host-resolved tenant from the context; their arguments were already validated against the
 * strict schemas in `schemas.ts`.
 */

const dbOf = (ctx: ToolContext) => ctx.db ?? createPublicClient();
const money = (cents: number, ctx: ToolContext) => formatCents(cents, ctx.tenant.currency);

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
  return { ...period, when: whenText(period.start, period.end, ctx.tenant.timezone) };
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

function mergeItems(items: StagedItem[]): StagedItem[] {
  const byVariant = new Map<string, StagedItem>();
  for (const i of items) {
    const seen = byVariant.get(i.variantId);
    byVariant.set(
      i.variantId,
      seen ? { ...seen, quantity: Math.min(1000, seen.quantity + i.quantity) } : i,
    );
  }
  return [...byVariant.values()].slice(0, 10);
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
  };
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
    };
  }
  const reasonCode = delivery.status === "manual_review" ? delivery.reason : "NOT_REQUESTED";
  const reason = DELIVERY_REASON_TEXT[reasonCode] ?? "delivery could not be decided automatically";
  const outside = reasonCode === "OUTSIDE_SERVICE_AREA";
  return {
    status: "manual_review",
    result: {
      serviceArea: outside ? "outside_service_area" : "manual_review",
      address: where,
      reason,
      instruction: outside
        ? "The address is outside the configured delivery areas; the team can review special requests."
        : "Delivery could not be confirmed automatically; the team needs to review it.",
    },
    blocks: [
      {
        type: "service_area",
        status: outside ? "outside_service_area" : "manual_review",
        address: where,
        fee: null,
        label: null,
        reason,
      },
    ],
  };
}

// ── staging tools (no database write until create_quote) ───────────────────

function createCustomerTool(ctx: ToolContext, args: ToolArgs<"create_customer">): ToolOutcome {
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
    },
    blocks: [],
  };
}

function createEventTool(ctx: ToolContext, args: ToolArgs<"create_event">): ToolOutcome {
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
    },
    blocks: [],
  };
}

// ── quote and booking (the M5 public path) ─────────────────────────────────

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

async function createQuoteFromState(ctx: ToolContext, items: StagedItem[], message?: string) {
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
  const { contact, event } = ctx.state as Required<typeof ctx.state>;
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
  );
  const tokenHash = await hashQuoteToken(created.token);
  ctx.state.quote = { tokenHash, quoteNumber: created.quoteNumber, quoteId: created.quoteId };
  ctx.state.items = items;
  const view = await getPublicQuote(ctx.tenant, { tokenHash }, ctx.deps);
  if (!view) throw new Error("created quote not readable");
  return { created, view };
}

function quoteBlock(
  ctx: ToolContext,
  view: PublicQuoteView,
  token: string,
  replaces: string | null,
): AssistantBlock {
  return {
    type: "quote",
    quoteNumber: view.quoteNumber,
    url: `/q/${token}`,
    priceIsFinal: view.priceIsFinal,
    total: view.priceIsFinal ? money(view.totalCents, ctx) : null,
    replaces,
  };
}

async function createQuoteTool(
  ctx: ToolContext,
  args: ToolArgs<"create_quote">,
): Promise<ToolOutcome> {
  if (ctx.state.quote) {
    throw new ToolError(
      "QUOTE_EXISTS",
      `Quote ${ctx.state.quote.quoteNumber} already exists in this conversation. Use add_quote_item to change it or request_booking.`,
    );
  }
  const items = args.items
    ? mergeItems(await Promise.all(args.items.map((i) => stageItem(ctx, i))))
    : ctx.state.items;
  const { created, view } = await createQuoteFromState(ctx, items, args.message);
  return {
    status: view.priceIsFinal ? "ok" : "manual_review",
    result: { quote: "created", ...quoteSummary(ctx, view) },
    blocks: [quoteBlock(ctx, view, created.token, null)],
  };
}

async function currentQuote(ctx: ToolContext): Promise<PublicQuoteView | null> {
  if (!ctx.state.quote) return null;
  return getPublicQuote(ctx.tenant, { tokenHash: ctx.state.quote.tokenHash }, ctx.deps);
}

async function addQuoteItemTool(
  ctx: ToolContext,
  args: ToolArgs<"add_quote_item">,
): Promise<ToolOutcome> {
  const item = await stageItem(ctx, args);
  if (!ctx.state.quote) {
    ctx.state.items = mergeItems([...ctx.state.items, item]);
    return {
      status: "ok",
      result: {
        staged: "added",
        items: itemsText(ctx.state.items),
        note: "Not a quote yet. create_quote will price these items.",
      },
      blocks: [],
    };
  }
  const view = await currentQuote(ctx);
  const previous = ctx.state.quote.quoteNumber;
  if (!view || view.booking || !["draft", "sent", "viewed"].includes(view.status)) {
    throw new ToolError(
      "QUOTE_NOT_EDITABLE",
      `Quote ${previous} can no longer be changed here (a booking was requested or it is closed). The team can help with changes.`,
    );
  }
  // Snapshots are immutable: an updated quote is a new, fully re-priced quote (M5 path).
  const items = mergeItems([...ctx.state.items, item]);
  const { created, view: next } = await createQuoteFromState(ctx, items);
  return {
    status: next.priceIsFinal ? "ok" : "manual_review",
    result: { quote: "replaced", replaces: previous, ...quoteSummary(ctx, next) },
    blocks: [quoteBlock(ctx, next, created.token, previous)],
  };
}

const BOOKING_TEXT = {
  holding: "A booking request is already in progress and the items are on hold.",
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

async function requestBookingTool(
  ctx: ToolContext,
  args: ToolArgs<"request_booking">,
): Promise<ToolOutcome> {
  if (!ctx.state.quote) {
    throw new ToolError(
      "NO_QUOTE",
      "There is no quote in this conversation yet. Create one first (create_customer, create_event, create_quote).",
      "rejected_validation",
    );
  }
  const quoteNumber = ctx.state.quote.quoteNumber;
  const view = await currentQuote(ctx);
  if (!view) throw new ToolError("NOT_FOUND", "The quote could not be found.");
  const step = quoteNextStep(view);
  const refuse = (status: keyof typeof BOOKING_TEXT): ToolOutcome => ({
    status: "rejected_policy",
    errorCode: status.toUpperCase(),
    result: { booking: status, quoteNumber, message: BOOKING_TEXT[status] },
    blocks: [
      { type: "booking", status, quoteNumber, holdExpiresAt: null, message: BOOKING_TEXT[status] },
    ],
  });
  if (step.kind === "confirmed") return refuse("confirmed");
  if (step.kind === "closed") return refuse("closed");
  if (step.kind === "stale") return refuse("stale");
  if (step.kind === "expired") return refuse("expired");
  if (step.kind === "holding") return refuse("holding");
  if (step.kind === "awaiting_review") return refuse("awaiting_review");
  if (step.kind === "none") return refuse("needs_review");

  let hold: { holdExpiresAt: string };
  try {
    hold = await requestPublicBooking(
      ctx.tenant,
      { tokenHash: ctx.state.quote.tokenHash },
      args.message ? { message: args.message } : {},
      ctx.meta,
      ctx.deps,
    );
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "PUBLIC_HOLD_LIMIT") return refuse("hold_limit");
    if (code === "INSUFFICIENT_AVAILABILITY" || code === "BLOCKED") return refuse("unavailable");
    if (code === "STALE_BOOKING_REQUEST") return refuse("stale");
    if (code === "QUOTE_EXPIRED") return refuse("expired");
    if (code === "REVIEW_REQUIRED") return refuse("needs_review");
    if (code === "INVALID_INPUT" && !ctx.meta.visitorToken) return refuse("needs_page_reload");
    throw e;
  }
  const minutes = Math.max(
    1,
    Math.round((Date.parse(hold.holdExpiresAt) - ctx.now().getTime()) / 60_000),
  );
  const message =
    `Your booking request has been submitted and the inventory is being held for ${String(minutes)} minutes.` +
    (view.priceIsFinal
      ? ""
      : " The price still needs the team's review before the team confirms the booking.");
  return {
    status: "ok",
    result: {
      booking: "hold_placed",
      quoteNumber,
      holdMinutes: minutes,
      holdExpiresAt: hold.holdExpiresAt,
      priceIsFinal: view.priceIsFinal,
      message,
      instruction:
        "Use exactly this message. The booking is NOT confirmed: the team confirms it. Never say it is booked or paid.",
    },
    blocks: [
      {
        type: "booking",
        status: "hold_placed",
        quoteNumber,
        holdExpiresAt: hold.holdExpiresAt,
        message,
      },
    ],
  };
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
 * reach the model or the customer.
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
    raw = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
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
  try {
    const impl = TOOL_IMPLEMENTATIONS[name] as (
      c: ToolContext,
      a: unknown,
    ) => Promise<ToolOutcome> | ToolOutcome;
    return await impl(ctx, parsed.data);
  } catch (e) {
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
