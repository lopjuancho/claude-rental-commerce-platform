import { describe, expect, it } from "vitest";
import {
  availabilityReplayVerdict,
  bookingReplayVerdict,
  expectedWhen,
  freshAvailabilityVerdict,
  leaksServerRefs,
  safeExcerpt,
  unsupportedStateClaims,
} from "../../scripts/ai-smoke-checks.mjs";

/** The live smoke's customer-visible checks (scripts/ai-smoke-checks.mjs). */
describe("unsupportedStateClaims: the state assertion itself, in its own scope", () => {
  it.each([
    // Codex reproductions (false passes before)
    "If you need reassurance your booking is confirmed.",
    "If you want reassurance your booking is confirmed.",
    "No worries, it is confirmed.",
    "No worries it is confirmed.",
    "Your booking is confirmed, right?",
    "Pending bookings are confirmed.",
    // the live A–F matrix
    "All the umpteen quotes are booked.",
    "All the 11 quotes are booked.",
    "All of them are confirmed.",
    "They are all umpteen booked.",
    "They are all of the eleven quotes confirmed.",
    "They are all of the eleven quotes, which, as you know, have been confirmed.",
    "I can confirm your booking is confirmed.",
    "I can tell you your items are held.",
    "I can assure you your booking is confirmed.",
    "I can confirm that your booking is confirmed.",
    "Once again your booking is confirmed.",
    "Your booking will be confirmed; contact us if you have questions.",
    "Your booking will be confirmed and let us know if you need help.",
    "Your items will be held; contact us if you have questions.",
    "Your booking will be confirmed.",
    "If you request a booking, the items are held for 15 minutes.",
    // payment/other
    "You're all locked in and the deposit is paid.",
    "Your card has been charged.",
    "Availability is guaranteed.",
    "Your date is secured.",
    "Here is where your request stands now. Your items remain reserved for you.",
  ])("flags “%s”", (reply) => {
    expect(unsupportedStateClaims(reply).length).toBeGreaterThan(0);
  });

  it.each([
    // Codex reproductions (false fails before)
    "Your booking could be confirmed if the team approves it.",
    "The items can be held if you request a booking.",
    "I cannot tell you that your booking is confirmed.",
    // required safe cases
    "Your booking is not confirmed.",
    "Nothing has been booked yet.",
    "I need to check whether it is confirmed.",
    "Is your booking confirmed?",
    // more
    "I want to make sure I only share confirmed details. Please check the details shown below, or ask me to check again.",
    "I need the team to review that before I can give you a confirmed price.",
    "I can't confirm that.",
    "Your booking hasn't been confirmed yet.",
    "Would you like me to request the booking so the items can be held?",
    "The team needs to review it before it is confirmed.",
    "I need to check that before anything is reserved.",
    "You have not been charged and nothing is paid.",
    "If the quote is confirmed, it will be booked.",
    "Once approved, it will be held.",
    "Here is what I found.",
    "Here is where your request stands now. This booking request was cancelled.",
  ])("does not flag “%s”", (reply) => {
    expect(unsupportedStateClaims(reply)).toEqual([]);
  });
});

describe("availability replay/fresh checks", () => {
  const when = expectedWhen("2027-04-03");
  const expected = { slug: "party-slide", when, quantity: 1 };
  const card = (o: Record<string, unknown> = {}) => ({
    type: "availability",
    product: { slug: "party-slide" },
    when,
    quantity: 1,
    status: "unavailable",
    ...o,
  });
  it("the expected window text", () => {
    expect(when).toBe("Sat, Apr 3, 2027, 12:00 PM – 4:00 PM");
  });
  it("fresh check: exact product, date, quantity and UNAVAILABLE", () => {
    expect(freshAvailabilityVerdict(card(), expected).ok).toBe(true);
    expect(freshAvailabilityVerdict(card({ product: { slug: "other" } }), expected).ok).toBe(false);
    expect(freshAvailabilityVerdict(card({ when: expectedWhen("2027-04-10") }), expected).ok).toBe(
      false,
    );
    expect(freshAvailabilityVerdict(card({ quantity: 2 }), expected).ok).toBe(false);
    expect(freshAvailabilityVerdict(card({ status: "manual_review" }), expected).ok).toBe(false);
    expect(freshAvailabilityVerdict(card({ status: "available" }), expected).ok).toBe(false);
    expect(freshAvailabilityVerdict(null, expected).ok).toBe(false);
  });
  const RECHECK =
    "Availability needs to be checked again: it can change at any time. Ask me and I'll check it now.";
  it("replay: neutral re-check passes; any positive availability or a card fails", () => {
    expect(availabilityReplayVerdict(RECHECK, []).ok).toBe(true);
    expect(
      availabilityReplayVerdict(`${RECHECK} Party Slide remains available for your date.`, []).ok,
    ).toBe(false);
    expect(availabilityReplayVerdict(`${RECHECK} Yes, it is available.`, []).ok).toBe(false);
    expect(availabilityReplayVerdict(`${RECHECK} It is still open that afternoon.`, []).ok).toBe(
      false,
    );
    expect(availabilityReplayVerdict(RECHECK, [card()]).ok).toBe(false);
    expect(availabilityReplayVerdict("Party Slide is available.", []).ok).toBe(false);
  });
});

describe("booking replay check (after the smoke cancelled its request)", () => {
  const cancelled = { type: "booking", quoteNumber: "Q-7", status: "cancelled" };
  const expected = { quoteNumber: "Q-7", status: "cancelled" };
  const neutral = "Here is where your request stands now. This booking request was cancelled.";
  it("neutral cancelled prose with the cancelled card passes", () => {
    expect(bookingReplayVerdict(neutral, [cancelled], expected).ok).toBe(true);
  });
  it.each([
    ["“reserved for you”", `${neutral} Your items remain reserved for you.`, [cancelled]],
    ["“confirmed”", `${neutral} Your booking is confirmed.`, [cancelled]],
    ["held wording", `${neutral} The items are held until 3:45 PM.`, [cancelled]],
    ["no cancelled card", neutral, []],
    ["an active hold card", neutral, [cancelled, { ...cancelled, status: "holding" }]],
    ["not rebuilt", "This booking request was cancelled.", [cancelled]],
  ])("fails with %s", (_l, reply, blocks) => {
    expect(bookingReplayVerdict(reply, blocks, expected).ok).toBe(false);
  });
});

describe("leaksServerRefs / safeExcerpt", () => {
  it("detects hashes and server-only fields", () => {
    expect(leaksServerRefs(JSON.stringify({ reply: "ok", blocks: [] }))).toBe(false);
    expect(leaksServerRefs(`{"x":"${"a".repeat(64)}"}`)).toBe(true);
    expect(leaksServerRefs('{"blocks":[{"quoteRef":"x"}]}')).toBe(true);
    expect(leaksServerRefs('{"refs":{"bookings":[]}}')).toBe(true);
  });
  it("masks hashes and private quote links", () => {
    const e = safeExcerpt(`see /q/${"A".repeat(43)} and ${"b".repeat(64)}`);
    expect(e).not.toContain("A".repeat(43));
    expect(e).not.toContain("b".repeat(64));
  });
});
