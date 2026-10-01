import { describe, expect, it } from "vitest";
import {
  leaksServerRefs,
  safeExcerpt,
  unsupportedStateClaims,
} from "../../scripts/ai-smoke-checks.mjs";

/** The live smoke's customer-visible claim check (scripts/ai-smoke-checks.mjs). */
describe("unsupportedStateClaims", () => {
  it.each([
    "All the umpteen quotes are booked.",
    "They are all of the eleven quotes confirmed.",
    "I can confirm your booking is confirmed.",
    "I can tell you your items are held.",
    "Once again your booking is confirmed.",
    "Pending bookings are confirmed.",
    "Your booking will be confirmed; contact us if you have questions.",
    "Your items will be held; contact us if you have questions.",
    "You're all locked in and the deposit is paid.",
    "Your card has been charged.",
    "Availability is guaranteed.",
    "Your date is secured.",
  ])("flags “%s”", (reply) => {
    expect(unsupportedStateClaims(reply).length).toBeGreaterThan(0);
  });

  it.each([
    "I want to make sure I only share confirmed details. Please check the details shown below, or ask me to check again.",
    "I need the team to review that before I can give you a confirmed price.",
    "I can't confirm that.",
    "Your booking is not confirmed.",
    "Nothing has been booked yet.",
    "I need to check that before anything is reserved.",
    "Would you like me to request the booking so the items can be held?",
    "If you request a booking, the items are held for 15 minutes.",
    "The team needs to review it before it is confirmed.",
    "You have not been charged and nothing is paid.",
    "Here is what I found.",
  ])("does not flag “%s”", (reply) => {
    expect(unsupportedStateClaims(reply)).toEqual([]);
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
