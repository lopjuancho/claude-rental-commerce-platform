import { describe, expect, it } from "vitest";
import { addEvidence, type Evidence, type EvidenceOf } from "@/domain/assistant/evidence";
import {
  checkGrounding,
  factSentences,
  type GroundingInput,
  parseQuantity,
  timeSensitiveClaims,
} from "@/domain/assistant/grounding";

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
): EvidenceOf<"booking"> => ({
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

describe("Codex round-3 bypasses: every assertion matches its OWN subject", () => {
  const JAN2 = "2027-01-02";
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
  const q1: Evidence = {
    ...booking("confirmed", null, "This booking is confirmed by the team."),
    quoteNumber: "Q-1",
  };
  const q2: Evidence = {
    ...booking("refused", null, "The team declined this booking request."),
    quoteNumber: "Q-2",
  };
  const run = (reply: string, evidence: Evidence[]) =>
    checkGrounding({
      reply,
      evidence,
      now: NOW,
      knownProducts: ["Party Slide"],
      businessName: "Acme Party Rentals",
      currency: "USD",
    });

  it("1. “No worries your booking is confirmed.” — fillers negate nothing", () => {
    expect(run("No worries your booking is confirmed.", []).ok).toBe(false);
    expect(run("No problem your reservation is confirmed.", []).ok).toBe(false);
    expect(run("Not a problem, you're all set.", []).ok).toBe(false);
    expect(run("No worries, nothing has been paid yet.", []).ok).toBe(true);
    expect(run("Your booking is not confirmed yet.", []).ok).toBe(true);
  });

  it("2. a server sentence attributed to ANOTHER quote is not exempt", () => {
    expect(run("Quote Q-2: This booking is confirmed by the team.", [q1, q2]).ok).toBe(false);
    expect(run("For quote Q-2 — This booking is confirmed by the team.", [q1, q2]).ok).toBe(false);
    expect(run("Quote Q-1: This booking is confirmed by the team.", [q1, q2]).ok).toBe(true);
    expect(run("This booking is confirmed by the team.", [q1]).ok).toBe(true);
  });

  it("3. multi-quote claims need evidence for EACH quote", () => {
    expect(run("Quotes Q-2 and Q-1 are confirmed.", [q1, q2]).ok).toBe(false);
    expect(run("Quotes Q-1 and Q-2 are both booked.", [q1, q2]).ok).toBe(false);
    expect(run("Quote Q-1 is confirmed.", [q1, q2]).ok).toBe(true);
    const q3: Evidence = { ...q1, quoteNumber: "Q-3" };
    expect(run("Quotes Q-1 and Q-3 are confirmed.", [q1, q3]).ok).toBe(true);
  });

  it("4. written quantities are quantities", () => {
    expect(
      run("Party Slide is available for five hundred units on 2027-01-02.", [partySlide]).ok,
    ).toBe(false);
    expect(
      run("Party Slide is available for twenty-five of them on 2027-01-02.", [partySlide]).ok,
    ).toBe(false);
    expect(run("Party Slide is available for 1,000 units on 2027-01-02.", [partySlide]).ok).toBe(
      false,
    );
    expect(run("Party Slide is available for a dozen on 2027-01-02.", [partySlide]).ok).toBe(false);
    expect(run("Party Slide is available for one unit on 2027-01-02.", [partySlide]).ok).toBe(true);
  });

  it("multiple products: each must have its own current result", () => {
    expect(
      checkGrounding({
        reply: "Party Slide and Bounce Castle are available on 2027-01-02.",
        evidence: [partySlide],
        now: NOW,
        knownProducts: ["Party Slide", "Bounce Castle"],
        businessName: "Acme Party Rentals",
        currency: "USD",
      }).ok,
    ).toBe(false);
  });
});

describe("Codex round-4 bypasses: every asserted subject is resolved and supported", () => {
  const JAN2 = "2027-01-02";
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
  const confirmedQ = (n: string): Evidence => ({
    ...booking("confirmed", null, "This booking is confirmed by the team."),
    quoteNumber: n,
  });
  const refusedQ = (n: string): Evidence => ({
    ...booking("refused", null, "The team declined this booking request."),
    quoteNumber: n,
  });
  const heldQ = (n: string): Evidence => ({ ...booking("hold_placed", 15), quoteNumber: n });
  const q1 = confirmedQ("Q-1");
  const q2 = refusedQ("Q-2");
  const ORDERS: [string, Evidence[]][] = [
    ["Q-1 first, Q-2 second", [q1, q2]],
    ["Q-2 first, Q-1 second", [q2, q1]],
  ];
  const run = (reply: string, evidence: Evidence[]) =>
    checkGrounding({
      reply,
      evidence,
      now: NOW,
      knownProducts: ["Party Slide"],
      businessName: "Acme Party Rentals",
      currency: "USD",
    });

  describe.each(ORDERS)("evidence order: %s", (_label, evidence) => {
    it("1. “Both quotes are booked.” never resolves to the latest single booking", () => {
      expect(run("Both quotes are booked.", evidence).ok).toBe(false);
      expect(run("Both bookings are confirmed.", evidence).ok).toBe(false);
      expect(run("All the quotes are booked.", evidence).ok).toBe(false);
      expect(run("The bookings are confirmed.", evidence).ok).toBe(false);
      expect(run("They are both confirmed.", evidence).ok).toBe(false);
      expect(run("All three quotes are booked.", evidence).ok).toBe(false);
      expect(run("Quotes Q-1, Q-2 and Q-3 are held.", evidence).ok).toBe(false);
    });

    it("2. “Quotes Q-2 and Q-1: This booking is confirmed by the team.” keeps the whole subject set", () => {
      expect(run("Quotes Q-2 and Q-1: This booking is confirmed by the team.", evidence).ok).toBe(
        false,
      );
      expect(run("Quotes Q-1 and Q-2: This booking is confirmed by the team.", evidence).ok).toBe(
        false,
      );
      expect(
        run("I checked Q-2 and Q-1. This booking is confirmed by the team.", evidence).ok,
      ).toBe(false);
      expect(run("Both quotes: This booking is confirmed by the team.", evidence).ok).toBe(false);
      // The message about its own quote alone stays exempt.
      expect(run("Quote Q-1: This booking is confirmed by the team.", evidence).ok).toBe(true);
    });
  });

  it("plural claims pass only when EXACTLY the referenced set is known and all have the state", () => {
    const q3 = confirmedQ("Q-3");
    expect(run("Both quotes are booked.", [q1, q3]).ok).toBe(true);
    expect(run("Both quotes are booked.", [q3, q1]).ok).toBe(true);
    expect(run("Both bookings are confirmed.", [q1]).ok).toBe(false); // only one known
    expect(run("All three quotes are booked.", [q1, q3]).ok).toBe(false); // count mismatch
    expect(run("All three quotes are booked.", [q1, q3, confirmedQ("Q-4")]).ok).toBe(true);
    expect(run("Quotes Q-1, Q-2 and Q-3 are held.", [heldQ("Q-1"), heldQ("Q-2")]).ok).toBe(false);
    expect(
      run("Quotes Q-1, Q-2 and Q-3 are held.", [heldQ("Q-1"), heldQ("Q-2"), heldQ("Q-3")]).ok,
    ).toBe(true);
    expect(run("Both quotes are held.", [heldQ("Q-1"), refusedQ("Q-2")]).ok).toBe(false);
  });

  it("3. “quantity 1,000” is one thousand, not one", () => {
    expect(run("Party Slide is available on 2027-01-02, quantity 1,000.", [partySlide]).ok).toBe(
      false,
    );
    expect(run("Party Slide is available on 2027-01-02, qty 1,000.", [partySlide]).ok).toBe(false);
    expect(run("Party Slide is available on 2027-01-02, quantity 1000.", [partySlide]).ok).toBe(
      false,
    );
  });

  it("4. “quantity twenty-five” and every written quantity are parsed", () => {
    for (const q of [
      "quantity twenty-five",
      "quantity twenty five",
      "quantity one thousand",
      "quantity a dozen",
      "qty 1,000",
      "twenty-five units",
      "a dozen",
    ]) {
      expect(run(`Party Slide is available on 2027-01-02, ${q}.`, [partySlide]).ok, q).toBe(false);
    }
    expect(run("Party Slide is available on 2027-01-02, quantity one.", [partySlide]).ok).toBe(
      true,
    );
    expect(run("Party Slide is available on 2027-01-02, quantity 1.", [partySlide]).ok).toBe(true);
  });

  it("one canonical quantity parser: every syntax yields the same integer", () => {
    expect(parseQuantity("1000")).toBe(1000);
    expect(parseQuantity("1,000")).toBe(1000);
    expect(parseQuantity("one thousand")).toBe(1000);
    expect(parseQuantity("twenty-five")).toBe(25);
    expect(parseQuantity("twenty five")).toBe(25);
    expect(parseQuantity("five hundred")).toBe(500);
    expect(parseQuantity("a dozen")).toBe(12);
    expect(parseQuantity("two dozen")).toBe(24);
    expect(parseQuantity("half a dozen")).toBe(6);
    expect(parseQuantity("banana")).toBeNull();
    const same = (reply: string) =>
      run(`Party Slide is available on 2027-01-02, ${reply}.`, [{ ...partySlide, quantity: 1000 }])
        .ok;
    for (const form of [
      "1000 units",
      "1,000 units",
      "quantity 1000",
      "quantity 1,000",
      "qty 1000",
      "quantity one thousand",
    ]) {
      expect(same(form), form).toBe(true);
    }
    const dozen = (form: string) =>
      run(`Party Slide is available on 2027-01-02, ${form}.`, [{ ...partySlide, quantity: 12 }]).ok;
    expect(dozen("a dozen")).toBe(true);
    expect(dozen("quantity a dozen")).toBe(true);
    expect(dozen("quantity twenty-five")).toBe(false);
    const twentyFive = (form: string) =>
      run(`Party Slide is available on 2027-01-02, ${form}.`, [{ ...partySlide, quantity: 25 }]).ok;
    for (const form of ["quantity twenty-five", "quantity twenty five", "twenty-five units"]) {
      expect(twentyFive(form), form).toBe(true);
    }
  });
});

describe("Codex round-5: a stated count never silently disappears (H1)", () => {
  const confirmedQ = (n: string): Evidence => ({
    ...booking("confirmed", null, "This booking is confirmed by the team."),
    quoteNumber: n,
  });
  const heldQ = (n: string): Evidence => ({ ...booking("hold_placed", 15), quoteNumber: n });
  const confirmed = (n: number) =>
    Array.from({ length: n }, (_, i) => confirmedQ(`Q-${String(i + 1)}`));
  const held = (n: number) => Array.from({ length: n }, (_, i) => heldQ(`Q-${String(i + 1)}`));
  const run = (reply: string, evidence: Evidence[]) =>
    checkGrounding({
      reply,
      evidence,
      now: NOW,
      knownProducts: [],
      businessName: "Acme Party Rentals",
      currency: "USD",
    }).ok;

  it("two confirmed quotes: counts above ten are read and rejected", () => {
    const two = confirmed(2);
    for (const reply of [
      "All eleven quotes are booked.",
      "All twelve bookings are confirmed.",
      "All twenty quotes are confirmed.",
      "All thirteen quotes are booked.",
      "All thirty quotes are booked.",
      "All one hundred quotes are booked.",
      "All 11 quotes are booked.",
      "All 1,000 quotes are booked.",
      "Twenty-one quotes are booked.",
    ]) {
      expect(run(reply, two), reply).toBe(false);
    }
    expect(run("All twenty-one quotes are held.", held(2))).toBe(false);
  });

  it("matching counts pass when every subject is supported", () => {
    expect(run("All eleven quotes are booked.", confirmed(11))).toBe(true);
    expect(run("All twelve bookings are confirmed.", confirmed(12))).toBe(true);
    expect(run("All twenty quotes are confirmed.", confirmed(20))).toBe(true);
    expect(run("All twenty-one quotes are held.", held(21))).toBe(true);
    expect(run("All eleven quotes are booked.", confirmed(12))).toBe(false);
  });

  it("numeric and written counts give identical results", () => {
    for (const [written, numeric] of [
      ["eleven", "11"],
      ["twelve", "12"],
      ["thirteen", "13"],
      ["twenty", "20"],
      ["twenty-one", "21"],
      ["thirty", "30"],
      ["one hundred", "100"],
      ["one thousand", "1,000"],
    ] as const) {
      for (const n of [2, 11, 12, 20, 21]) {
        const ev = confirmed(n);
        expect(run(`All ${written} quotes are booked.`, ev), `${written}/${String(n)}`).toBe(
          run(`All ${numeric} quotes are booked.`, ev),
        );
      }
    }
  });

  it("an unreadable count is rejected, not ignored", () => {
    expect(run("All umpteen quotes are booked.", confirmed(2))).toBe(false);
    expect(run("All several quotes are booked.", confirmed(2))).toBe(false);
  });

  it("singular and plural edge cases", () => {
    const one = confirmed(1);
    expect(run("One quote is booked.", one)).toBe(true);
    expect(run("Your one booking is confirmed.", one)).toBe(true);
    expect(run("All one quote is booked.", one)).toBe(false); // conservative
    expect(run("Both two quotes are booked.", confirmed(2))).toBe(true);
    expect(run("Both two quotes are booked.", confirmed(3))).toBe(false);
    expect(run("Both three quotes are booked.", confirmed(3))).toBe(false); // conflicting counts
    expect(run("All 2 quotes are booked.", confirmed(2))).toBe(true);
    expect(run("All 2 quotes are booked.", confirmed(1))).toBe(false);
    expect(run("One quote is booked.", confirmed(2))).toBe(true); // the latest single booking
    // An article is not a count.
    expect(run("Your items are held while a hold is active.", held(1))).toBe(true);
  });
});

describe("availability wording of either polarity is time-sensitive (R3-M1, round 5)", () => {
  it.each([
    "Party Slide is unavailable.",
    "Party Slide is not available.",
    "Party Slide is available on Saturday.",
    "Sorry, that date is sold out.",
    "There is no availability that day.",
    "Good news: availability is confirmed.",
    "The castle is still open that afternoon.",
    "It's out of stock for that time.",
  ])("%s", (reply) => {
    expect(timeSensitiveClaims(reply).availability).toBe(true);
  });
  it("plain replies are not", () => {
    expect(timeSensitiveClaims("Here is what I found.").availability).toBe(false);
    expect(timeSensitiveClaims("Your quote Q-1 is ready.").availability).toBe(false);
  });
});

describe("Codex round-6: unreadable counts stay unresolved; plural never means one booking", () => {
  const confirmedQ = (n: string): Evidence => ({
    ...booking("confirmed", null, "This booking is confirmed by the team."),
    quoteNumber: n,
  });
  const refusedQ = (n: string): Evidence => ({
    ...booking("refused", null, "The team declined this booking request."),
    quoteNumber: n,
  });
  const heldQ = (n: string): Evidence => ({ ...booking("hold_placed", 15), quoteNumber: n });
  const run = (reply: string, evidence: Evidence[]) =>
    checkGrounding({
      reply,
      evidence,
      now: NOW,
      knownProducts: [],
      businessName: "Acme Party Rentals",
      currency: "USD",
    }).ok;
  const ORDERS = (a: Evidence, b: Evidence): [string, Evidence[]][] => [
    ["first/second", [a, b]],
    ["second/first", [b, a]],
  ];

  describe.each(ORDERS(confirmedQ("Q-1"), confirmedQ("Q-2")))(
    "Q-1 and Q-2 confirmed (%s)",
    (_l, evidence) => {
      it.each([
        "All the umpteen quotes are booked.",
        "All umpteen active quotes are booked.",
        "All umpteen of your quotes are booked.",
        "All of your umpteen quotes are booked.",
        "Both several quotes are booked.",
        "All zillion bookings are confirmed.",
        "Several quotes are booked.",
      ])("%s → rejected (unreadable count)", (reply) => {
        expect(run(reply, evidence)).toBe(false);
      });
      it("matching plural claims still pass", () => {
        expect(run("All of them are confirmed.", evidence)).toBe(true);
        expect(run("Both quotes are booked.", evidence)).toBe(true);
        expect(run("All the quotes are booked.", evidence)).toBe(true);
        expect(run("All two quotes are booked.", evidence)).toBe(true);
        expect(run("All of your active quotes are booked.", evidence)).toBe(true);
      });
    },
  );

  describe.each(ORDERS(heldQ("Q-1"), heldQ("Q-2")))("Q-1 and Q-2 held (%s)", (_l, evidence) => {
    it("held-state equivalents", () => {
      expect(run("All the umpteen quotes are held.", evidence)).toBe(false);
      expect(run("All umpteen of your quotes are held.", evidence)).toBe(false);
      expect(run("All of them are held.", evidence)).toBe(true);
    });
  });

  describe.each(ORDERS(confirmedQ("Q-1"), refusedQ("Q-2")))(
    "Q-1 confirmed, Q-2 refused (%s)",
    (_l, evidence) => {
      it("a plural claim over a set with one refusal is rejected", () => {
        expect(run("All of them are confirmed.", evidence)).toBe(false);
        expect(run("They are all booked.", evidence)).toBe(false);
        expect(run("Those bookings are confirmed.", evidence)).toBe(false);
      });
    },
  );

  it("one known booking: a plural claim never resolves to it", () => {
    for (const reply of [
      "All of them are confirmed.",
      "They are confirmed.",
      "Both are booked.",
      "The bookings are confirmed.",
      "All the quotes are booked.",
      "Those bookings are confirmed.",
    ]) {
      expect(run(reply, [confirmedQ("Q-1")]), reply).toBe(false);
    }
    expect(run("All of them are held.", [heldQ("Q-1")])).toBe(false);
    // Singular claims still use the single booking.
    expect(run("Your booking is confirmed.", [confirmedQ("Q-1")])).toBe(true);
    expect(run("Quote Q-1 is confirmed.", [confirmedQ("Q-1")])).toBe(true);
    // One named quote under plural wording is not enough.
    expect(run("Quote Q-1: they are all confirmed.", [confirmedQ("Q-1")])).toBe(false);
  });
});
