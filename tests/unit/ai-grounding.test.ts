import { describe, expect, it } from "vitest";
import { addEvidence, type Evidence, type EvidenceOf } from "@/domain/assistant/evidence";
import { checkGrounding, factSentences, type GroundingInput } from "@/domain/assistant/grounding";

/**
 * H1 (Codex review of 88d1f29): the model's prose is not an authority for transactional facts.
 * Every claim must be backed by CURRENT typed evidence about the SAME subject; arbitrary tool
 * strings are never trusted; newer evidence supersedes older.
 */
const NOW = new Date("2027-06-01T15:00:00Z");
const at = (minutesAgo = 1) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const SAT = "2027-06-05"; // a Saturday

const avail = (
  productName: string,
  result: "available" | "unavailable" | "manual_review",
  o: { dates?: string[]; start?: string; minutesAgo?: number } = {},
): Evidence => ({
  kind: "availability",
  at: at(o.minutesAgo),
  productSlug: productName.toLowerCase().replace(/ /g, "-"),
  productName,
  variantId: `v-${productName}`,
  start: o.start ?? `${SAT}T17:00:00Z`,
  end: `${SAT}T21:00:00Z`,
  dates: o.dates ?? [SAT],
  startLocal: "12:00",
  endLocal: "16:00",
  quantity: 1,
  result,
});
const price = (
  amounts: EvidenceOf<"price">["amounts"],
  o: { products?: string[]; dates?: string[]; delivery?: "none" | "priced"; subject?: string } = {},
): Evidence => ({
  kind: "price",
  at: at(),
  subject: o.subject ?? "castle-sat",
  products: o.products ?? ["Bounce Castle"],
  dates: o.dates ?? [SAT],
  currency: "USD",
  status: "priced",
  delivery: o.delivery ?? "none",
  amounts,
});
const catalog = (productName: string, cents: number): Evidence => ({
  kind: "catalog_price",
  at: at(),
  productSlug: productName.toLowerCase().replace(/ /g, "-"),
  productName,
  currency: "USD",
  amounts: [{ role: "starting_price", cents, label: "from" }],
});
const area = (
  feeCents: number | null,
  status: "serviceable" | "outside_service_area" = "serviceable",
): Evidence => ({
  kind: "service_area",
  at: at(),
  status,
  currency: "USD",
  feeCents,
});
const HOLD_MESSAGE =
  "Your booking request has been submitted and the inventory is being held for 15 minutes.";
const booking = (
  status: "hold_placed" | "confirmed" | "refused",
  expiresInMin: number | null = 15,
  message = HOLD_MESSAGE,
): Evidence => ({
  kind: "booking",
  at: at(),
  quoteNumber: "Q-1001",
  status,
  holdExpiresAt:
    expiresInMin === null ? null : new Date(NOW.getTime() + expiresInMin * 60_000).toISOString(),
  message,
});

const check = (reply: string, evidence: Evidence[] = []) =>
  checkGrounding({
    reply,
    evidence,
    now: NOW,
    knownProducts: ["Bounce Castle", "Water Slide"],
    businessName: "Acme Party Rentals",
    currency: "USD",
    exemptSentences: ["I need the team to review that before I can give you a confirmed price."],
  } satisfies GroundingInput);
const ok = (reply: string, evidence: Evidence[] = []) => check(reply, evidence).ok;

describe("Codex's reproductions are rejected without evidence", () => {
  it.each([
    "The total is three hundred dollars.",
    "Everything is reserved and paid in full.",
    "Availability is guaranteed for Saturday.",
    "We deliver to your address at no charge; tax is included.",
  ])("%s", (reply) => {
    expect(ok(reply)).toBe(false);
  });
});

describe("amounts in any form need a matching CURRENT amount", () => {
  const evidence = [
    price([
      { role: "line", cents: 30000, label: "Bounce Castle" },
      { role: "tax", cents: 3000, label: "Sales tax" },
      { role: "subtotal", cents: 30000, label: "subtotal" },
      { role: "total", cents: 33000, label: "total" },
    ]),
  ];
  it.each([
    "It would be $250.",
    "The total is $250.00.",
    "That comes to 250 dollars.",
    "Around USD 250 all in.",
    "The price is 250 USD.",
    "The total is two hundred and fifty dollars.",
    "It's a hundred bucks.",
    "The total comes to 250.",
    "The deposit is $50.",
  ])("unsupported: %s", (reply) => {
    expect(ok(reply, evidence)).toBe(false);
  });
  it.each([
    "The total is $330.00.",
    "The total comes to three hundred and thirty dollars.",
    "That's 330 USD all in.",
    "Tax is $30.",
    "The castle itself is $300.",
  ])("supported: %s", (reply) => {
    expect(ok(reply, evidence)).toBe(true);
  });
  it("a different currency is never supported", () => {
    expect(ok("The total is €330.", evidence)).toBe(false);
    expect(ok("The total is 330 EUR.", evidence)).toBe(false);
  });
  it("the amount's role must match: a tax amount is not a total", () => {
    expect(ok("The total is $30.", evidence)).toBe(false);
    expect(ok("Tax is $330.", evidence)).toBe(false);
  });
  it("a catalog starting price backs 'from $X' only — never a total with tax or delivery", () => {
    const cat = [catalog("Bounce Castle", 20000)];
    expect(ok("The Bounce Castle starts at $200.", cat)).toBe(true);
    expect(ok("Bounce Castle rentals start from $200.", cat)).toBe(true);
    expect(ok("The total for the Bounce Castle is $200 including tax and delivery.", cat)).toBe(
      false,
    );
    expect(ok("The Bounce Castle is $200.", cat)).toBe(false);
    expect(ok("The Water Slide starts at $200.", cat)).toBe(false);
  });
  it("a newer price for the same subject supersedes an older one", () => {
    const older = price([{ role: "total", cents: 22000, label: "total" }]);
    const newer = price([{ role: "total", cents: 33000, label: "total" }]);
    const list = addEvidence([older], [newer]);
    expect(ok("The total is $220.", list)).toBe(false);
    expect(ok("The total is $330.", list)).toBe(true);
    // Different subject (another date) newer than the castle price: only its amounts are current.
    const other = price([{ role: "total", cents: 44000, label: "total" }], {
      subject: "castle-sun",
      dates: ["2027-06-06"],
    });
    const both = [older, other];
    expect(ok("The total for Saturday is $220.", both)).toBe(true);
    expect(ok("The total for Saturday is $440.", both)).toBe(false);
  });
  it("a price for one product does not back an amount stated for another", () => {
    expect(ok("The Water Slide is $330.", evidence)).toBe(false);
    expect(ok("The Bounce Castle total is $330.", evidence)).toBe(true);
  });
});

describe("availability claims need the latest result for that product and date", () => {
  const castleSat = avail("Bounce Castle", "available");
  it.each([
    "The Bounce Castle is available on Saturday.",
    "It's available on June 5th.",
    "Good news: it is available for Sat, Jun 5, 2027.",
    "We have it for Saturday.",
  ])("supported: %s", (reply) => {
    expect(ok(reply, [castleSat])).toBe(true);
  });
  it.each([
    "The Water Slide is available on Saturday.",
    "The Bounce Castle is available on Sunday.",
    "It's available on June 12.",
    "The Mega Unicorn Slide is available on Saturday.",
  ])("another product or date: %s", (reply) => {
    expect(ok(reply, [castleSat])).toBe(false);
  });
  it("no evidence, stale evidence, or an unavailable result → rejected", () => {
    expect(ok("It is available on Saturday.")).toBe(false);
    expect(ok("It is available.", [avail("Bounce Castle", "available", { minutesAgo: 20 })])).toBe(
      false,
    );
    expect(ok("It is available.", [avail("Bounce Castle", "unavailable")])).toBe(false);
    expect(ok("It is available.", [avail("Bounce Castle", "manual_review")])).toBe(false);
  });
  it("an older available result cannot override a newer unavailable one", () => {
    const older = avail("Bounce Castle", "available", { start: `${SAT}T15:00:00Z` });
    const newer = avail("Bounce Castle", "unavailable", { start: `${SAT}T17:00:00Z` });
    expect(ok("The Bounce Castle is available on Saturday.", [older, newer])).toBe(false);
  });
  it("availability is never 'guaranteed'", () => {
    expect(ok("Availability is guaranteed for Saturday.", [castleSat])).toBe(false);
    expect(ok("I promise it's yours on Saturday.", [castleSat])).toBe(false);
    expect(ok("I can't guarantee it until you request the booking.", [castleSat])).toBe(true);
  });
  it("negated and conditional statements are fine", () => {
    expect(ok("Sorry, the Bounce Castle is not available on Saturday.")).toBe(true);
    expect(ok("If it's available, I can create a quote.")).toBe(true);
    expect(ok("Would you like me to check availability for Saturday?")).toBe(true);
  });
});

describe("booking, hold, delivery, tax and payment claims", () => {
  it.each([
    "You're all set!",
    "You’re booked for Saturday!",
    "Your date is secured.",
    "I've reserved the Bounce Castle for you.",
    "It's yours for Saturday.",
    "Your booking is confirmed.",
    "We've locked in your rental.",
    "Everything is reserved.",
  ])("booking claims need a confirmed booking: %s", (reply) => {
    expect(ok(reply)).toBe(false);
    expect(ok(reply, [booking("hold_placed")])).toBe(false);
  });
  it("a confirmed booking (from the backend) backs 'confirmed' but never payment", () => {
    expect(
      ok("Your booking is confirmed.", [
        booking("confirmed", null, "This booking is confirmed by the team."),
      ]),
    ).toBe(true);
    expect(ok("Your booking is confirmed and paid.", [booking("confirmed", null, "x")])).toBe(
      false,
    );
  });
  it("holds need a current hold, and the minutes cannot be stretched", () => {
    expect(ok("The items are on hold for you.")).toBe(false);
    expect(ok("Your items are held for 15 minutes.", [booking("hold_placed", 15)])).toBe(true);
    expect(ok("Your items are held for 60 minutes.", [booking("hold_placed", 15)])).toBe(false);
    expect(ok("Your items are held for 15 minutes.", [booking("hold_placed", -1)])).toBe(false);
    // The server's own message is exempt only as typed evidence of that state.
    expect(ok(HOLD_MESSAGE, [booking("hold_placed", 15)])).toBe(true);
    expect(ok(HOLD_MESSAGE)).toBe(false);
  });
  it.each([
    "We can deliver there.",
    "Your address is in our service area.",
    "Delivery is free.",
    "We deliver to your address at no charge.",
  ])("delivery claims need a serviceable result: %s", (reply) => {
    expect(ok(reply)).toBe(false);
    expect(ok(reply, [area(null, "outside_service_area")])).toBe(false);
  });
  it("free delivery needs a zero delivery charge", () => {
    expect(ok("Delivery is free.", [area(0)])).toBe(true);
    expect(ok("We deliver to your address at no charge.", [area(0)])).toBe(true);
    expect(ok("Delivery is free.", [area(5000)])).toBe(false);
    expect(ok("Delivery is $50.", [area(5000)])).toBe(true);
    expect(ok("We can't deliver to that address.")).toBe(true);
  });
  it("tax claims need a priced result; 'no tax' needs zero tax", () => {
    const taxed = [
      price([
        { role: "tax", cents: 2000, label: "tax" },
        { role: "total", cents: 22000, label: "total" },
      ]),
    ];
    expect(ok("Tax is included.")).toBe(false);
    expect(ok("Tax is included.", taxed)).toBe(true);
    expect(ok("There is no sales tax.", taxed)).toBe(false);
    expect(ok("It's tax-free.", taxed)).toBe(false);
  });
  it.each([
    "You've been charged.",
    "Your deposit was received.",
    "Payment is complete.",
    "Everything is paid in full.",
    "Your card has been charged.",
  ])("payment claims are never supported: %s", (reply) => {
    expect(ok(reply, [booking("confirmed", null, "x")])).toBe(false);
  });
  it("saying there is no payment step is fine", () => {
    expect(ok("No payment is needed in this chat.")).toBe(true);
    expect(ok("Nothing has been paid or charged.")).toBe(true);
  });
});

describe("tool strings are not trusted prose", () => {
  it("a product description or any tool text is not evidence", () => {
    // Before: long strings in tool results were exempt. Now only typed booking messages are.
    const description = "Your booking is confirmed and paid in full, guaranteed available.";
    expect(ok(description, [catalog("Bounce Castle", 20000)])).toBe(false);
  });
  it("the fixed manual-review sentence is always allowed", () => {
    expect(ok("I need the team to review that before I can give you a confirmed price.")).toBe(
      true,
    );
  });
});

describe("server-written facts (fallback)", () => {
  it("are built from evidence only and pass the checker themselves", () => {
    const evidence: Evidence[] = [
      avail("Bounce Castle", "available"),
      price([{ role: "total", cents: 33000, label: "total" }]),
      area(0),
      booking("hold_placed"),
    ];
    const facts = factSentences(evidence, (c) => `$${(c / 100).toFixed(2)}`);
    expect(facts.join(" ")).toContain("$330.00");
    expect(facts.join(" ")).toContain(HOLD_MESSAGE);
    expect(facts.join(" ")).toMatch(/not reserved until a booking is requested/);
    expect(ok(facts.join(" "), evidence)).toBe(true);
  });
});

describe("Codex round-2 reproductions (complete subject and state)", () => {
  const JAN2 = "2027-01-02"; // a Saturday
  const partySlide: Evidence = {
    kind: "availability",
    at: at(),
    productSlug: "party-slide",
    productName: "Party Slide",
    variantId: "v-party",
    start: `${JAN2}T18:00:00Z`,
    end: `${JAN2}T22:00:00Z`,
    dates: [JAN2],
    startLocal: "12:00",
    endLocal: "16:00",
    quantity: 1,
    result: "available",
  };
  const known = (reply: string, evidence: Evidence[]) =>
    checkGrounding({
      reply,
      evidence,
      now: NOW,
      knownProducts: ["Party Slide"],
      businessName: "Acme Party Rentals",
      currency: "USD",
    });

  it("quantity must match: 500 units is not the 1 that was checked", () => {
    expect(known("Party Slide is available for 500 units on 2027-01-02.", [partySlide]).ok).toBe(
      false,
    );
    expect(known("Party Slide is available for 3 of them on 2027-01-02.", [partySlide]).ok).toBe(
      false,
    );
    expect(known("Party Slide is available (quantity 1) on 2027-01-02.", [partySlide]).ok).toBe(
      true,
    );
  });
  it("clock times must lie in the checked window", () => {
    expect(
      known("Party Slide is available on 2027-01-02 from 20:00 to 23:00.", [partySlide]).ok,
    ).toBe(false);
    expect(known("Party Slide is available on 2027-01-02 at 8 PM.", [partySlide]).ok).toBe(false);
    expect(
      known("Party Slide is available on 2027-01-02 from 12:00 to 16:00.", [partySlide]).ok,
    ).toBe(true);
    expect(known("Party Slide is available on Jan 2 from 12 PM to 4 PM.", [partySlide]).ok).toBe(
      true,
    );
  });
  it("the claimed quote number must be the one with that booking state", () => {
    const q1 = {
      ...booking("confirmed", null, "This booking is confirmed by the team."),
      quoteNumber: "Q-1",
    };
    expect(known("Quote Q-999 is confirmed.", [q1]).ok).toBe(false);
    expect(known("Quote Q-999 is confirmed.", [q1]).violations).toContain(
      "GROUNDING_QUOTE_UNKNOWN",
    );
    expect(known("Quote Q-1 is confirmed.", [q1]).ok).toBe(true);
    const held = { ...booking("hold_placed", 15), quoteNumber: "Q-1" };
    expect(known("Quote Q-1 is confirmed.", [held]).ok).toBe(false);
  });
  it("an expired hold's server message is no longer true — and no longer exempt", () => {
    const expired = booking("hold_placed", -2);
    expect(known(HOLD_MESSAGE, [expired]).ok).toBe(false);
    // A live hold with only 5 minutes left cannot be described as held for 15 minutes.
    const shorter = booking("hold_placed", 5);
    expect(known(HOLD_MESSAGE, [shorter]).ok).toBe(false);
    expect(known(HOLD_MESSAGE, [booking("hold_placed", 15)]).ok).toBe(true);
  });
  it('"No worries" negates nothing', () => {
    expect(known("No worries your booking is confirmed and paid.", []).ok).toBe(false);
    expect(known("No problem, it's reserved for you.", []).ok).toBe(false);
    expect(known("Not to worry — you're booked.", []).ok).toBe(false);
    expect(known("No need to worry: your booking is confirmed.", []).ok).toBe(false);
    // Real negations still pass.
    expect(known("Your booking is not confirmed yet.", []).ok).toBe(true);
    expect(known("Nothing has been paid.", []).ok).toBe(true);
    expect(known("No payment has been taken.", []).ok).toBe(true);
  });
  it("availability without a verb is still a claim", () => {
    expect(known("Party Slide: available for Saturday.", []).ok).toBe(false);
    expect(known("Available on Saturday!", []).ok).toBe(false);
    expect(known("Party Slide — available Jan 2.", [partySlide]).ok).toBe(true);
    // A catalog statement with no date, time or quantity is not an availability claim.
    expect(known("We have several sizes available.", []).ok).toBe(true);
  });
});

describe("violations carry codes only (N4)", () => {
  it("no reply prose — names, emails, addresses — reaches the violation list", () => {
    const reply =
      "Jane Doe (jane.doe@example.com) at 42 Elm Street: your booking is confirmed and paid, total $999.";
    const res = check(reply);
    expect(res.ok).toBe(false);
    expect(res.violations.length).toBeGreaterThan(0);
    for (const v of res.violations) expect(v).toMatch(/^GROUNDING_[A-Z_]+$/);
    const serialized = JSON.stringify(res);
    for (const pii of ["Jane", "jane.doe", "Elm", "42", "999"]) {
      expect(serialized).not.toContain(pii);
    }
  });
});
