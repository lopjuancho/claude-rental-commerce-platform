import { describe, expect, it } from "vitest";
import { bookingRequested } from "@/domain/assistant/booking-intent";

const OFFER =
  "I created a quote for one castle. Would you like me to request a booking hold for it?";

describe("bookingRequested: only the customer's own request places a hold", () => {
  it.each([
    "Please request the booking.",
    "Please request the booking now.",
    "Please request the booking for quote Q-1004.",
    "Please request the booking for this quote.",
    "Book it, please.",
    "I want to book the castle for Saturday.",
    "Please reserve one for me.",
    "Can you book it?",
    "Could you place a hold on it?",
    "Go ahead and submit the booking request.",
    "OK, please hold it.",
  ])("requested: “%s”", (message) => {
    expect(bookingRequested(message, null)).toBe(true);
  });

  it.each([
    // The live smoke failure: a quote request right after the assistant offered a hold.
    "Please create my quote for one M7 Smoke Test Castle.",
    "Please add one more castle to my quote.",
    "Actually, move the party to 2026-12-12, same times.",
    "What is the status of my booking request right now?",
    "Is my booking confirmed?",
    "Don't book it yet.",
    "Please do not request the booking until I check with my spouse.",
    "I'm not ready to book; just the quote for now.",
    "Can I see the price first?",
    "Tell me about the booking process.",
  ])("not requested: “%s” (even after a booking offer)", (message) => {
    expect(bookingRequested(message, OFFER)).toBe(false);
  });

  it("a short yes to the assistant's own booking offer is a request", () => {
    for (const yes of ["Yes", "Yes please", "Sure, go ahead.", "OK", "Yes, do it!"]) {
      expect(bookingRequested(yes, OFFER)).toBe(true);
    }
  });

  it("a yes without a booking offer — or a long or negated reply — is not", () => {
    expect(bookingRequested("Yes please", "Here is your quote. Anything else?")).toBe(false);
    expect(bookingRequested("Yes please", null)).toBe(false);
    expect(bookingRequested("No thanks", OFFER)).toBe(false);
    expect(
      bookingRequested(
        "Yes, but first I want to compare it with the water slide and the obstacle course",
        OFFER,
      ),
    ).toBe(false);
  });
});
