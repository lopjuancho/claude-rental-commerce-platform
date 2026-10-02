/**
 * Whether the customer asked for a booking request in THIS message (ADR 0017: the AI is the
 * salesperson, the backend is the authority). A booking request places a real inventory hold, so
 * the backend requires the customer's own words for it — never the model's initiative: "Please
 * create my quote" after the assistant offered a hold is NOT a booking request.
 *
 * Accepted: an explicit request ("book it", "please reserve one", "request the booking", "place a
 * hold", "submit the booking request"), or a short yes to the assistant's own booking offer in its
 * previous message ("Yes, please" after "Would you like me to request a booking hold?").
 * Refused: anything else, including a negated request ("don't book it yet") and questions about
 * a booking ("what is my booking status?"). When unsure, it refuses — the model then asks.
 */

const REQUEST = [
  // "book it", "please book", "I want to book the castle" (not "booking", "booked", "a book")
  /\b(?:book|reserve)\b(?!\s+(?:status|of|about)\b)/,
  // "request the booking", "requesting a reservation", "request a hold"
  /\brequest(?:ing)?\s+(?:the\s+|a\s+|my\s+|this\s+|that\s+)?(?:booking|reservation|hold)\b/,
  // "place a hold", "put a hold on it", "hold it"
  /\b(?:place|put)\s+(?:a\s+|the\s+)?hold\b|\bhold\s+(?:it|them|one|those|that|this)\b/,
  // "make / submit / send the booking (request)"
  /\b(?:make|submit|send|place)\s+(?:the\s+|a\s+|my\s+)?(?:booking|reservation)\b/,
];
/**
 * A negation before the request in the same sentence ("don't book", "not ready to book", "no need
 * to", "hold off"): never read as a request (a false refusal only makes the model ask).
 */
const NEGATED = /\bnot\b|n't\b|\bnever\b|\bno\s+need\b|\bwithout\b|\bhold\s+off\b|\bwait\b/;
/** A reply made only of affirmation words ("Yes", "Sure, go ahead.", "Yes please, do it!"). */
const AFFIRMATION_WORDS = new Set(
  "yes yeah yep yup sure ok okay please do it go ahead sounds good absolutely definitely let's lets that thanks thank you great perfect".split(
    " ",
  ),
);
const AFFIRMING = /\b(?:yes|yeah|yep|yup|sure|ok|okay|absolutely|definitely|go ahead|do it)\b/;
/** The assistant's previous message offered to request a booking/hold (a question). */
const OFFER = /\b(?:book|reserve|booking|reservation|hold)\b[^?]*\?/;

const sentences = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

export function bookingRequested(message: string, previousAssistant: string | null): boolean {
  const parts = sentences(message);
  for (const s of parts) {
    if (s.endsWith("?") && !/\b(?:can|could|would|will)\s+you\b/.test(s)) continue; // a question
    for (const r of REQUEST) {
      const m = r.exec(s);
      if (m && !NEGATED.test(s.slice(0, m.index + m[0].length))) return true;
    }
  }
  const whole = parts.join(" ");
  const words = whole.match(/[a-z']+/g) ?? [];
  if (
    words.length > 0 &&
    words.length <= 8 &&
    words.every((w) => AFFIRMATION_WORDS.has(w)) &&
    AFFIRMING.test(whole) &&
    previousAssistant !== null &&
    OFFER.test(previousAssistant.toLowerCase())
  ) {
    return true;
  }
  return false;
}
