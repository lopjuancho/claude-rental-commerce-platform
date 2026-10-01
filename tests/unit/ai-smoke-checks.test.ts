import { describe, expect, it } from "vitest";
import {
  availabilityReplayVerdict,
  bookingReplayVerdict,
  expectedWhen,
  freshAvailabilityVerdict,
  leaksServerRefs,
  providerObservationVerdict,
  safeExcerpt,
  smokeExitCode,
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

describe("Codex smoke round 3: affirmative knowledge is an assertion; adverbs keep negation", () => {
  it.each([
    "I know that your booking is confirmed.",
    "I am sure that your booking is confirmed.",
    "I can verify that your items are held.",
    "No matter what happens your booking is confirmed.",
    "I know your items are reserved for you.",
    "I am certain your booking is booked.",
    "I can confirm that your booking is booked.",
  ])("flags “%s”", (reply) => {
    expect(unsupportedStateClaims(reply).length).toBeGreaterThan(0);
  });
  it.each([
    "Your booking is not yet confirmed.",
    "Your booking cannot yet be confirmed.",
    "Your booking is not actually confirmed.",
    "Your booking has not yet been booked.",
    "I do not know whether your booking is confirmed.",
    "I am not sure whether your booking is confirmed.",
    "I need to check whether your booking is confirmed.",
    "I need to check that your booking is confirmed.",
    "No booking is confirmed.",
    "None of the quotes are confirmed.",
  ])("does not flag “%s”", (reply) => {
    expect(unsupportedStateClaims(reply)).toEqual([]);
  });
  it("the replay verdicts inherit it", () => {
    const neutral = "Here is where your request stands now. This booking request was cancelled.";
    const cancelled = [{ type: "booking", quoteNumber: "Q-7", status: "cancelled" }];
    const expected = { quoteNumber: "Q-7", status: "cancelled" };
    expect(
      bookingReplayVerdict(`${neutral} I know that your booking is confirmed.`, cancelled, expected)
        .ok,
    ).toBe(false);
    expect(
      bookingReplayVerdict(
        `${neutral} No matter what happens your booking is confirmed.`,
        cancelled,
        expected,
      ).ok,
    ).toBe(false);
    const RECHECK =
      "Availability needs to be checked again: it can change at any time. Ask me and I'll check it now.";
    expect(availabilityReplayVerdict(`${RECHECK} I am sure that it is available.`, []).ok).toBe(
      false,
    );
    expect(availabilityReplayVerdict(`${RECHECK} I know the slide is available.`, []).ok).toBe(
      false,
    );
  });
});

describe("Codex smoke round 4: the embedding clause's OWN stance; negation adverbs", () => {
  it.each([
    "I know that your booking is confirmed.",
    "I am sure that your booking is confirmed.",
    "I am certain that your booking is confirmed.",
    "I can verify that your items are held.",
    "I can confirm that your booking is booked.",
    "I do not doubt that your booking is confirmed.",
    "I don't doubt that your booking is confirmed.",
    "I have no doubt that your booking is confirmed.",
    "Not only can I confirm that your booking is confirmed, I can also help you plan.",
    "I can confidently say that your booking is confirmed.",
    "Your booking is not just confirmed.",
  ])("flags “%s”", (reply) => {
    expect(unsupportedStateClaims(reply).length).toBeGreaterThan(0);
  });
  it.each([
    "I do not know whether your booking is confirmed.",
    "I am not sure whether your booking is confirmed.",
    "I am not sure that your booking is confirmed.",
    "I doubt that your booking is confirmed.",
    "I cannot confirm that your booking is confirmed.",
    "I cannot tell you that your booking is confirmed.",
    "Nobody can tell you that your booking is confirmed.",
    "I need to check whether your booking is confirmed.",
    "Your booking is not formally confirmed.",
    "Your booking is not presently confirmed.",
    "Your booking is not currently confirmed.",
    "Your booking has not officially been booked.",
    "Your items are not presently held.",
    "Your quote is not fully approved.",
    "Your booking is not yet confirmed.",
    "Your booking cannot yet be confirmed.",
    "Your booking is not actually confirmed.",
    "Your booking has not yet been booked.",
  ])("does not flag “%s”", (reply) => {
    expect(unsupportedStateClaims(reply)).toEqual([]);
  });
  it("the replay verdicts inherit it", () => {
    const cancelled = [{ type: "booking", quoteNumber: "Q-7", status: "cancelled" }];
    const expected = { quoteNumber: "Q-7", status: "cancelled" };
    for (const claim of [
      "I do not doubt that your booking is confirmed.",
      "Not only can I confirm that your booking is confirmed, I can also help you plan.",
    ]) {
      const v = bookingReplayVerdict(
        `Here is where your request stands now. ${claim}`,
        cancelled,
        expected,
      );
      expect(v.ok).toBe(false);
      expect(v.reasons.join(" ")).toMatch(/asserts state/);
    }
    expect(
      bookingReplayVerdict(
        "Here is where your request stands now. Your booking is not presently confirmed.",
        cancelled,
        expected,
      ).ok,
    ).toBe(true);
    for (const claim of [
      "I do not doubt that it is available.",
      "Not only can I confirm that it is available, I can also help you plan.",
    ]) {
      const v = availabilityReplayVerdict(`Availability needs to be checked again. ${claim}`, []);
      expect(v.ok).toBe(false);
      expect(v.reasons.join(" ")).toMatch(/asserts availability/);
    }
    expect(
      availabilityReplayVerdict(
        "Availability needs to be checked again. I doubt that it is available.",
        [],
      ).ok,
    ).toBe(true);
  });
});

describe("Codex smoke round 5: composed polarity (nested and repeated negation fail closed)", () => {
  it.each([
    "It is not true that your booking is not confirmed.",
    "Your booking is not not confirmed.",
    "It is not false that your booking is confirmed.",
    "I cannot deny that your booking is confirmed.",
    "I do not disagree that your booking is confirmed.",
    "It is not true that I doubt that your booking is confirmed.",
    "Nothing is not booked.",
    "I am not sure whether your booking is not confirmed.",
  ])("flags “%s”", (reply) => {
    expect(unsupportedStateClaims(reply).length).toBeGreaterThan(0);
  });
  it.each([
    "It is not true that your booking is confirmed.",
    "Your booking is not confirmed.",
    "I cannot confirm that your booking is confirmed.",
    "I deny that your booking is confirmed.",
    "It is false that your booking is confirmed.",
    "I am not sure whether your booking is confirmed.",
    "I know that your booking is not confirmed.",
  ])("does not flag “%s”", (reply) => {
    expect(unsupportedStateClaims(reply)).toEqual([]);
  });
  it("the replay verdicts compose the same way", () => {
    const cancelled = [{ type: "booking", quoteNumber: "Q-7", status: "cancelled" }];
    const expected = { quoteNumber: "Q-7", status: "cancelled" };
    for (const claim of [
      "It is not true that your booking is not confirmed.",
      "Your booking is not not confirmed.",
    ]) {
      const v = bookingReplayVerdict(
        `Here is where your request stands now. ${claim}`,
        cancelled,
        expected,
      );
      expect(v.ok).toBe(false);
      expect(v.reasons.join(" ")).toMatch(/asserts state/);
    }
    expect(
      bookingReplayVerdict(
        "Here is where your request stands now. It is not true that your booking is confirmed.",
        cancelled,
        expected,
      ).ok,
    ).toBe(true);
    for (const claim of [
      "It is not true that it is not available.",
      "It is not false that it is available.",
    ]) {
      const v = availabilityReplayVerdict(`Availability needs to be checked again. ${claim}`, []);
      expect(v.ok).toBe(false);
      expect(v.reasons.join(" ")).toMatch(/asserts availability/);
    }
    expect(
      availabilityReplayVerdict(
        "Availability needs to be checked again. It is not true that it is available.",
        [],
      ).ok,
    ).toBe(true);
  });
});

describe("providerObservationVerdict", () => {
  const ok = { modelCalls: 2, telemetry: "complete" };
  const replay0 = { modelCalls: 0, telemetry: "complete" };
  it("passes only with complete observation, zero replay calls and an unchanged durable count", () => {
    expect(
      providerObservationVerdict({ first: ok, replay: replay0, dbBefore: 5, dbAfter: 5 }).ok,
    ).toBe(true);
  });
  it.each([
    [
      "original telemetry incomplete",
      { first: { ...ok, telemetry: "incomplete" }, replay: replay0, dbBefore: 5, dbAfter: 5 },
    ],
    [
      "replay telemetry incomplete",
      { first: ok, replay: { ...replay0, telemetry: "incomplete" }, dbBefore: 5, dbAfter: 5 },
    ],
    ["headers missing", { first: {}, replay: {}, dbBefore: 5, dbAfter: 5 }],
    [
      "replay called the model",
      { first: ok, replay: { ...replay0, modelCalls: 1 }, dbBefore: 5, dbAfter: 6 },
    ],
    ["durable count changed", { first: ok, replay: replay0, dbBefore: 5, dbAfter: 6 }],
    ["no durable rows at all", { first: ok, replay: replay0, dbBefore: 0, dbAfter: 0 }],
  ])("fails (or is inconclusive) when %s", (_l, input) => {
    expect(providerObservationVerdict(input).ok).toBe(false);
  });
});

describe("smokeExitCode", () => {
  const clean = {
    failedChecks: 0,
    bookingCleanup: "succeeded (released)",
    blockCleanup: "succeeded",
    recovery: [] as string[],
  };
  it("0 only when every check passed and cleanup is proven", () => {
    expect(smokeExitCode(clean)).toBe(0);
    expect(
      smokeExitCode({ ...clean, bookingCleanup: "not attempted", blockCleanup: "not created" }),
    ).toBe(0);
  });
  it.each([
    ["a failed check", { failedChecks: 1 }],
    ["booking cleanup failed", { bookingCleanup: "failed (database error)" }],
    ["booking cleanup unresolved", { bookingCleanup: "unresolved (confirmed booking request)" }],
    ["block cleanup failed", { blockCleanup: "failed (not found)" }],
    ["block cleanup pending", { blockCleanup: "pending" }],
    ["manual cleanup needed", { recovery: ["availability block id x"] }],
  ])("non-zero when %s", (_l, over) => {
    expect(smokeExitCode({ ...clean, ...over })).toBe(1);
  });
});
