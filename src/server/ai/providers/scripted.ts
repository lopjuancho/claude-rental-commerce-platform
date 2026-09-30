import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "../provider";

/**
 * Deterministic test double for the model (E2E and integration; refused in production by env
 * validation). It maps a few customer phrasings to tool calls and writes replies ONLY from tool
 * results, so tests exercise the real tools, persistence, grounding and UI — never a fake catalog.
 */
export class ScriptedProvider implements LlmProvider {
  readonly id = "scripted";
  readonly model = "scripted-test-double";

  complete(req: LlmRequest): Promise<LlmResponse> {
    return Promise.resolve(respond(req.messages));
  }
}

const usage = { inputTokens: 0, outputTokens: 0 };
let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): LlmResponse => ({
  text: null,
  toolCalls: [
    {
      id: `call_${String(++callSeq)}`,
      name,
      arguments: JSON.stringify(args),
    } satisfies LlmToolCall,
  ],
  usage,
});
const say = (text: string): LlmResponse => ({ text, toolCalls: [], usage });

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const TIMES = /\bfrom (\d{1,2}:\d{2}) to (\d{1,2}:\d{2})\b/i;
const ADDRESS = /\b(\d+ [^,]+), ([^,]+), ([A-Z]{2}) (\d{5})\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

function respond(messages: LlmMessage[]): LlmResponse {
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  const user = messages[lastUserIndex];
  if (!user || user.role !== "user") return say("How can I help with your event?");
  const text = user.content;
  const u = text.toLowerCase();
  const turn = messages.slice(lastUserIndex + 1);
  const ranThisTurn = new Set(
    turn.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.name) : [])),
  );
  const userTexts = messages.flatMap((m) => (m.role === "user" ? [m.content] : []));
  const find = (re: RegExp) =>
    [...userTexts]
      .reverse()
      .map((t) => re.exec(t))
      .find(Boolean) ?? null;
  const date = find(DATE)?.[1];
  const times = find(TIMES);
  const address = find(ADDRESS);
  const window =
    date && times ? { date, startTime: pad(times[1] ?? ""), endTime: pad(times[2] ?? "") } : null;
  const addr = address
    ? {
        line1: address[1] ?? "",
        city: address[2] ?? "",
        state: address[3] ?? "",
        postalCode: address[4] ?? "",
      }
    : null;
  const fulfillment = addr ? { fulfillment: "delivery", address: addr } : { fulfillment: "pickup" };
  const slug = lastProductSlug(messages);
  const last = messages.at(-1);

  const plan: [boolean, () => LlmResponse | null][] = [
    [
      /request (the )?booking|book it/.test(u),
      () => (ranThisTurn.has("request_booking") ? null : call("request_booking", {})),
    ],
    [
      /create (my|the|a) quote/.test(u),
      () =>
        !ranThisTurn.has("create_event") && window
          ? call("create_event", { ...window, ...fulfillment })
          : !ranThisTurn.has("create_quote") && slug
            ? call("create_quote", { items: [{ productSlug: slug, quantity: 1 }] })
            : null,
    ],
    [
      /my name is|my email/.test(u),
      () => {
        if (ranThisTurn.has("create_customer")) return null;
        const email = EMAIL.exec(text)?.[0];
        const name = /my name is (\w+)/i.exec(text)?.[1];
        return call("create_customer", {
          ...(name ? { firstName: name } : {}),
          ...(email ? { email } : {}),
        });
      },
    ],
    [
      /how much|price|cost/.test(u),
      () =>
        ranThisTurn.has("calculate_price") || !slug || !window
          ? null
          : call("calculate_price", {
              items: [{ productSlug: slug, quantity: 1 }],
              ...window,
              ...fulfillment,
            }),
    ],
    [
      /availab/.test(u),
      () =>
        ranThisTurn.has("check_availability") || !slug || !window
          ? null
          : call("check_availability", { productSlug: slug, quantity: 1, ...window }),
    ],
    [
      /tell me more|details|difference/.test(u),
      () =>
        ranThisTurn.has("get_product_details") || !slug
          ? null
          : call("get_product_details", { productSlug: slug }),
    ],
    [
      /\b(slide|bounce|castle|tent|chair|rent|rental|have|recommend)\b/.test(u),
      () =>
        ranThisTurn.has("search_products")
          ? null
          : call("search_products", { query: text.slice(0, 100) }),
    ],
  ];
  for (const [matches, next] of plan) {
    if (!matches) continue;
    const r = next();
    if (r) return r;
    break;
  }
  if (last?.role === "tool") return say(summarize(last.name, last.content));
  return say("I can help you find rentals, check a date, get a price and build a quote.");
}

const pad = (t: string) => (t.length === 4 ? `0${t}` : t);

function lastProductSlug(messages: LlmMessage[]): string | null {
  for (const m of [...messages].reverse()) {
    if (m.role === "system") {
      const s = /\(slug: ([a-z0-9-]+)\)/.exec(m.content);
      if (s) return s[1] ?? "";
    }
    if (m.role === "tool") {
      const s = /"slug":"([a-z0-9-]+)"/.exec(m.content);
      if (s) return s[1] ?? "";
    }
  }
  return null;
}

function summarize(tool: string, content: string): string {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return "Sorry, I could not check that right now.";
  }
  if (typeof r.error === "string")
    return `Sorry — ${typeof r.message === "string" ? r.message : "that did not work"}`;
  switch (tool) {
    case "search_products": {
      const names = ((r.products as { name: string }[] | undefined) ?? []).map((p) => p.name);
      return names.length
        ? `Here are some options: ${names.join(", ")}.`
        : "I could not find a matching rental.";
    }
    case "get_product_details":
      return `Here are the details for ${String(r.name)}.`;
    case "check_availability":
      return r.availability === "available"
        ? `Good news: ${String(r.product)} is available for ${String(r.when)}.`
        : r.availability === "manual_review"
          ? "The team needs to confirm that date with you."
          : `Sorry, ${String(r.product)} is not available for ${String(r.when)}.`;
    case "calculate_price":
      return r.pricing === "priced"
        ? `The total for ${String(r.when)} is ${String(r.total)}.`
        : "I need the team to review that before I can give you a confirmed price.";
    case "check_service_area":
      return r.serviceArea === "serviceable"
        ? "We deliver to that address."
        : "The team needs to review delivery to that address.";
    case "create_customer":
      return "Thanks, I saved your contact details for the quote.";
    case "create_event":
      return "I saved your event details.";
    case "create_quote":
    case "add_quote_item":
      return typeof r.quoteNumber === "string"
        ? `Your quote ${r.quoteNumber} is ready.`
        : "I added that.";
    case "request_booking":
      return typeof r.message === "string" ? r.message : "I could not request the booking.";
    default:
      return "Done.";
  }
}
