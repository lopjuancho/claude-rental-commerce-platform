/**
 * Pure checks for the live assistant smoke test (scripts/ai-live-smoke.mjs), unit-tested in
 * tests/unit/ai-smoke-checks.test.ts. They judge only what the CUSTOMER sees.
 *
 * Each booking/hold/payment (or availability) state word is classified in its OWN clause:
 *   A asserted · B negated/denied · C uncertain/not established · D hypothetical · E question
 * Only A counts as a claim. The decision uses the word's own verb chain, its own subject and the
 * construction it is embedded in — never "the sentence contains a negation/if/question mark".
 * When unsure, the analyzer leans to A (the gate fails rather than passes).
 */

const BOOKING_STATE =
  /\b(confirmed|booked|reserved|secured|finali[sz]ed|locked in|held|on hold|paid|charged|guaranteed)\b/gi;
const AVAILABILITY_STATE = /\b(available|open|in stock|free)\b/gi;

/** Fixed server sentences that contain a state word but assert nothing about a booking. */
const SERVER_PHRASES = [
  /I want to make sure I only share confirmed details\./gi,
  /I need the team to review that before I can give you a confirmed price\./gi,
  /\bconfirmed (?:details|price|information)\b/gi,
];
/** Conversational fillers containing a negator that negate nothing ("No worries, …"). */
const FILLERS =
  /\b(?:no worries|no worry|not to worry|no problem|no problems|not a problem|no rush|no stress|no doubt)\b/gi;

const TOKEN = /[A-Za-z0-9][A-Za-z0-9'-]*/g;
const AUX = new Set(
  "am is are was were be been being has have had do does did will would can could may might shall should must get gets got remain remains remained stay stays stayed".split(
    " ",
  ),
);
const MODALS = new Set("will would can could may might shall should must".split(" "));
const CHAIN_ADVERBS = new Set(
  "now already also still just officially fully definitely currently temporarily all both each".split(
    " ",
  ),
);
const NEGATORS = new Set(["not", "never", "no", "cannot"]);
const NEGATIVE_SUBJECTS = new Set(["nothing", "none", "no", "neither", "nobody", "noone"]);
const isNegator = (t) => NEGATORS.has(t) || /n't$/.test(t);
const isContractedAux = (t) => /'(?:re|s|ve|ll|d|m)$/.test(t);
/** Words a subordinate clause's subject may consist of ("before [the booking] is…"). */
const SUBJECT_WORDS = new Set(
  (
    "the your my our this that these those its their a an all both each every of it they them " +
    "anything everything something quote quotes booking bookings reservation reservations request " +
    "requests hold holds item items inventory date slot rental rentals event order orders deposit " +
    "payment card availability current pending confirmed active new existing"
  ).split(" "),
);
const CONDITION_OPENER =
  /^(?:and |but |so |or |then |only )?(?:if|unless|once(?! (?:again|more)\b)|when|whenever|provided(?: that)?|assuming(?: that)?|as soon as|in case)\b/;
const SUBORDINATORS = new Set([
  "if",
  "unless",
  "once",
  "when",
  "whenever",
  "before",
  "until",
  "after",
  "whether",
  "that",
]);
const UNCERTAIN_MATRIX =
  /\b(?:check|checking|verify|verifying|confirm whether|find out|see|ask|asking|know|sure|unsure|wonder|wondering|determine|unclear)\b/;
const QUESTION_OPENER =
  /^(?:is|are|was|were|do|does|did|has|have|had|can|could|will|would|should|may|might|what|which|when|where|who|how|why|whether)\b/;
const TRAILING_CONDITION =
  /^\s*(?:,\s*)?(?:(?:but\s+)?only\s+)?(?:if|unless|once(?!\s+(?:again|more)\b)|when|whenever|provided|assuming|as\s+soon\s+as|in\s+case)\b/i;
const CLAUSE_SPLIT =
  /;|,(?!\d)|:(?!\d)|\s[-—]\s|\s(?:but|however|although|though|whereas|while)\s/gi;

function clausesOf(sentence) {
  const out = [];
  let start = 0;
  for (const m of sentence.matchAll(CLAUSE_SPLIT)) {
    out.push({ start, text: sentence.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  out.push({ start, text: sentence.slice(start) });
  return out;
}

/**
 * Classifies one state word at `at` (an index into `sentence`). Returns "A".."E".
 */
export function classifyState(sentence, at, stateLength) {
  const clauses = clausesOf(sentence);
  const ci = clauses.findLastIndex((c) => c.start <= at);
  const clause = clauses[ci];
  const prefix = sentence.slice(clause.start, at);
  const tokens = (prefix.match(TOKEN) ?? []).map((t) => t.toLowerCase());
  const clauseTokens = (clause.text.match(TOKEN) ?? []).map((t) => t.toLowerCase());

  // E — a question whose OWN clause is interrogative ("Is your booking confirmed?"); a tag
  //     question ("Your booking is confirmed, right?") is still an assertion.
  if (sentence.trim().endsWith("?") && QUESTION_OPENER.test(clauseTokens.join(" "))) return "E";

  // The state word's own auxiliary chain (walking back over verbs, negators and adverbs).
  let i = tokens.length - 1;
  let modal = false;
  let negatedChain = false;
  while (i >= 0) {
    const t = tokens[i];
    if (MODALS.has(t) || /'(?:ll|d)$/.test(t)) modal = true;
    if (isNegator(t)) negatedChain = true;
    if (AUX.has(t) || MODALS.has(t) || isContractedAux(t) || isNegator(t) || CHAIN_ADVERBS.has(t)) {
      i--;
    } else break;
  }
  const chainStart = i + 1;
  // B — negated in its own chain ("is not confirmed", "hasn't been booked").
  if (negatedChain) return "B";

  // The clause the state word belongs to: from the last subordinator before its chain.
  let sub = -1;
  for (let k = 0; k < chainStart; k++) if (SUBORDINATORS.has(tokens[k])) sub = k;
  const subjectStart = Math.max(
    sub + 1,
    tokens.slice(0, chainStart).findLastIndex((t) => /^(?:and|or|but|so)$/.test(t)) + 1,
  );
  const subject = tokens.slice(subjectStart, chainStart);
  // B — a negative subject ("Nothing has been booked", "and nothing is paid").
  if (subject.some((t) => NEGATIVE_SUBJECTS.has(t))) return "B";

  if (sub >= 0) {
    const word = tokens[sub];
    const between = tokens.slice(sub + 1, chainStart);
    const ownClause = between.length > 0 && between.every((t) => SUBJECT_WORDS.has(t));
    const matrix = tokens.slice(0, sub);
    // C — "whether it is confirmed" is not established.
    if (word === "whether" && ownClause) return "C";
    if (word === "that" && ownClause) {
      // B/C — embedded under a negated or uncertain matrix ("I cannot tell you that …").
      if (matrix.some(isNegator)) return "B";
      if (UNCERTAIN_MATRIX.test(matrix.join(" "))) return "C";
    }
    // D — inside a condition/time clause of its own ("before it is confirmed", "if the quote
    //     is confirmed"); only when nothing but a subject stands between it and the chain.
    if (word !== "that" && word !== "whether" && ownClause) return "D";
  }

  // D — a modal claim of its own with a condition that governs it: attached directly after the
  //     state word, or fronted in an earlier clause ("Once approved, it will be held").
  if (modal) {
    const after = sentence.slice(at + stateLength);
    if (TRAILING_CONDITION.test(after)) return "D";
    const earlier = clauses.slice(0, ci).map((c) => c.text.trim().toLowerCase());
    if (earlier.some((c) => CONDITION_OPENER.test(c))) return "D";
  }
  // D — the antecedent itself ("If the quote is confirmed, …").
  const opener = CONDITION_OPENER.exec(clauseTokens.join(" "));
  if (opener) {
    const openerTokens = opener[0].split(" ").length;
    const between = tokens.slice(openerTokens, chainStart);
    if (between.length === 0 || between.every((t) => SUBJECT_WORDS.has(t))) return "D";
  }
  return "A";
}

function assertedStates(reply, pattern) {
  let text = String(reply ?? "").replace(/[‘’]/g, "'");
  for (const p of SERVER_PHRASES) text = text.replace(p, (m) => " ".repeat(m.length));
  text = text.replace(FILLERS, (m) => " ".repeat(m.length));
  const out = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    for (const m of sentence.matchAll(new RegExp(pattern.source, "gi"))) {
      if (classifyState(sentence, m.index, m[0].length) === "A") out.push(m[1].toLowerCase());
    }
  }
  return out;
}

/**
 * Positive (asserted) booking/hold/payment state claims a customer would read. For turns where
 * no such state exists, any of these is unsupported. The grounded server fallback passes.
 */
export function unsupportedStateClaims(reply) {
  return assertedStates(reply, BOOKING_STATE);
}

/** Positive availability assertions ("is available", "remains available", "still open"). */
export function availabilityClaims(reply) {
  return assertedStates(reply.replace(/\bavailability\b/gi, "            "), AVAILABILITY_STATE);
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

/** The card's "when" text for a local date and 12:00–16:00 (whenText in the app). */
export function expectedWhen(isoDate, start = "12:00 PM", end = "4:00 PM") {
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T12:00:00Z`));
  return `${day}, ${start} – ${end}`;
}

/**
 * The FRESH availability check after the smoke's block: exactly the expected product, window and
 * quantity, and UNAVAILABLE (manual review is not proof that the block changed availability).
 */
export function freshAvailabilityVerdict(card, expected) {
  const reasons = [];
  if (!card) reasons.push("no availability card");
  else {
    if (card.product?.slug !== expected.slug) reasons.push("wrong product");
    if (card.when !== expected.when) reasons.push("wrong date/time");
    if (card.quantity !== expected.quantity) reasons.push("wrong quantity");
    if (card.status !== "unavailable") reasons.push(`status ${String(card.status)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The availability REPLAY: no card, the neutral re-check line, and no positive availability
 * assertion anywhere in the reply.
 */
export function availabilityReplayVerdict(reply, blocks) {
  const reasons = [];
  if ((blocks ?? []).some((b) => b.type === "availability"))
    reasons.push("availability card replayed");
  if (!/Availability needs to be checked again/.test(reply ?? "")) reasons.push("no re-check line");
  const claims = availabilityClaims(reply ?? "");
  if (claims.length) reasons.push(`asserts availability (${claims.join(", ")})`);
  return { ok: reasons.length === 0, reasons };
}

/**
 * The booking REPLAY after the smoke cancelled its request: a cancelled card for the quote, no
 * active/held/confirmed card, the rebuilt reply, and no positive booking/hold state language.
 */
export function bookingReplayVerdict(reply, blocks, expected) {
  const reasons = [];
  const cards = (blocks ?? []).filter((b) => b.type === "booking");
  if (!cards.some((b) => b.quoteNumber === expected.quoteNumber && b.status === expected.status)) {
    reasons.push(`no ${expected.status} card for the quote`);
  }
  if (cards.some((b) => ["holding", "hold_placed", "confirmed"].includes(b.status))) {
    reasons.push("an active/held/confirmed card");
  }
  if (!/^Here is where your request stands now\./.test(reply ?? "")) reasons.push("not rebuilt");
  if (/held until|being held|on hold|reserved for you/i.test(reply ?? ""))
    reasons.push("hold wording");
  const claims = unsupportedStateClaims(reply ?? "");
  if (claims.length) reasons.push(`asserts state (${claims.join(", ")})`);
  return { ok: reasons.length === 0, reasons };
}
