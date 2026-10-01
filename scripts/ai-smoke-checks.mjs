/**
 * Pure checks for the live assistant smoke test (scripts/ai-live-smoke.mjs), unit-tested in
 * tests/unit/ai-smoke-checks.test.ts. They judge only what the CUSTOMER sees.
 */

/** Booking/hold/payment state words a reply must not assert without support. */
const STATE_WORDS =
  /\b(confirmed|booked|reserved|secured|finali[sz]ed|locked in|held|on hold|paid|charged|guaranteed)\b/gi;

/** Fixed server sentences that contain a state word but assert nothing about the booking. */
const SERVER_PHRASES = [
  /I want to make sure I only share confirmed details\./gi,
  /I need the team to review that before I can give you a confirmed price\./gi,
  /\bconfirmed (?:details|price|information)\b/gi,
];

/** Words that, shortly before a state word, make it a denial or an uncertainty. */
const NEGATION =
  /\b(?:not|never|no|nothing|none|cannot|can't|cant|unable|isn't|aren't|wasn't|weren't|won't|don't|doesn't|didn't|haven't|hasn't|yet|unless|until|before|whether|need|needs|needed|requires?)\b|n't\b/i;
// ("pending" is deliberately NOT a negation: "Pending bookings are confirmed." is a claim.)
/** A sentence opened by a condition or posed as a question asserts nothing. */
const CONDITIONAL_OPENER =
  /^\s*(?:if|unless|once(?!\s+(?:again|more)\b)|when|whether|before|until)\b/i;

/**
 * Positive booking/hold/payment state claims in a customer-visible reply — for turns where NO
 * booking or payment exists (a fresh session), so any positive claim is unsupported.
 *
 * Errs toward FAILING: a state word counts unless a negation/uncertainty word stands within the
 * four words before it, its sentence is a question, or its sentence opens with a condition. Fixed
 * server sentences ("I want to make sure I only share confirmed details.") are removed first, so
 * the grounded fallback is a pass. Returns the claimed words only (no other reply text).
 */
export function unsupportedStateClaims(reply) {
  let text = String(reply ?? "").replace(/[‘’]/g, "'");
  for (const p of SERVER_PHRASES) text = text.replace(p, " ");
  const claims = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s || s.endsWith("?") || CONDITIONAL_OPENER.test(s)) continue;
    for (const m of s.matchAll(STATE_WORDS)) {
      const before = s.slice(0, m.index).split(/\s+/).filter(Boolean).slice(-4).join(" ");
      if (NEGATION.test(before)) continue;
      claims.push(m[1].toLowerCase());
    }
  }
  return claims;
}

/** Whether a raw HTTP body carries anything server-only: a 64-hex hash or reference fields. */
export function leaksServerRefs(raw) {
  return (
    /\b[0-9a-f]{64}\b/.test(raw) || /quoteRef|sealedLink|"refs"|tokenHash|token_hash/.test(raw)
  );
}

/** A short, safe excerpt of customer-visible text for failure diagnostics. */
export function safeExcerpt(text, max = 160) {
  const t = String(text ?? "")
    .replace(/\b[0-9a-f]{64}\b/g, "<hash>")
    .replace(/\/q\/[A-Za-z0-9_-]{43}/g, "/q/<token>")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
