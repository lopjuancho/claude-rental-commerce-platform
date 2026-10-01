import { type AmountRole, type Evidence, type EvidenceOf, isFresh } from "./evidence";

/**
 * Reply grounding (ADR 0017 §4). The model's prose is NOT an authority for transactional facts:
 * the customer gets those from server-built cards, and when the prose itself makes a
 * transactional claim — an amount, availability, a delivery or tax statement, a hold or booking
 * status, a payment — the claim must be backed by CURRENT typed evidence about the SAME subject
 * (product, date, quote, amount role). Otherwise the whole reply is replaced by server-written
 * facts. Payments are never supported in M7; guarantees never are.
 *
 * Only server-written messages carried by typed evidence (a booking/hold message) and the fixed
 * manual-review sentence are exempt — never arbitrary strings from tool results.
 *
 * Pure: no I/O, unit-tested.
 */

export interface GroundingInput {
  reply: string;
  /** The conversation's evidence, oldest first (see addEvidence). */
  evidence: Evidence[];
  now: Date;
  /** Product names the assistant has seen in tool results (to recognise subjects). */
  knownProducts: string[];
  businessName: string;
  currency: string;
  /** Fixed server sentences that may be quoted verbatim. */
  exemptSentences?: string[];
}

export interface GroundingResult {
  ok: boolean;
  /** Stable codes only (see GROUNDING_CODES) — never text from the reply. */
  violations: GroundingCode[];
}

// ── money ────────────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };
const NUMBER_WORD = `(?:${[...Object.keys(UNITS), ...Object.keys(SCALES), "a", "and"].join("|")})`;
const WRITTEN = new RegExp(
  `\\b(${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*)\\s+(dollars?|bucks|euros?|pounds?)(?:\\s+and\\s+(${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*)\\s+cents?)?\\b`,
  "gi",
);

function wordsToNumber(words: string): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words.toLowerCase().split(/[\s-]+/)) {
    if (w === "and") continue;
    if (w === "a") {
      current = Math.max(current, 1);
      continue;
    }
    if (w in UNITS) {
      current += UNITS[w] ?? 0;
      seen = true;
    } else if (w === "hundred") {
      current = Math.max(current, 1) * 100;
      seen = true;
    } else if (w in SCALES) {
      total += Math.max(current, 1) * (SCALES[w] ?? 1);
      current = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + current : null;
}

const CODE_TO_CURRENCY: Record<string, string> = {
  $: "", // $ alone: the business's dollar currency
  usd: "USD",
  us$: "USD",
  dollar: "",
  dollars: "",
  bucks: "",
  eur: "EUR",
  "€": "EUR",
  euro: "EUR",
  euros: "EUR",
  gbp: "GBP",
  "£": "GBP",
  pound: "GBP",
  pounds: "GBP",
  cad: "CAD",
  c$: "CAD",
};

interface MoneyMention {
  index: number;
  cents: number;
  currency: string; // "" = unspecified
  text: string;
}

const SYMBOL_AMOUNT =
  /(us\$|c\$|\$|€|£|\busd|\beur|\bgbp|\bcad)\s?(\d[\d,]*(?:\.\d{1,2})?)(?!\d)/gi;
const AMOUNT_WORD =
  /(?<![\w$.])(\d[\d,]*(?:\.\d{1,2})?)\s?(dollars?|bucks|usd|eur|euros?|gbp|pounds?|cad)\b/gi;
/** A bare number right after a money word: "the total is 300". */
const BARE_AFTER_MONEY_WORD =
  /\b(total|cost|costs|price|priced at|fee|tax|taxes|charge|comes to|come to|pay|subtotal|deposit)\b(?:\s+(?:is|are|of|would be|will be|comes to|at|:))?\s+(\d[\d,]*(?:\.\d{1,2})?)(?![\d%])(?!\s?(?:ft|feet|foot|kids|children|guests|people|riders|minutes|hours|am|pm|years?|x))/gi;
const FREE_WORDS =
  /\b(free(?: of charge)?|no (?:extra |additional )?(?:charge|cost|fee)|at no (?:extra |additional )?(?:charge|cost)|complimentary|waived)\b/gi;

const toCents = (n: string) => Math.round(Number.parseFloat(n.replace(/,/g, "")) * 100);

function moneyMentions(text: string): MoneyMention[] {
  const out: MoneyMention[] = [];
  const taken: [number, number][] = [];
  const push = (m: MoneyMention, len: number) => {
    if (taken.some(([s, e]) => m.index < e && m.index + len > s)) return;
    taken.push([m.index, m.index + len]);
    out.push(m);
  };
  for (const m of text.matchAll(SYMBOL_AMOUNT)) {
    push(
      {
        index: m.index,
        cents: toCents(m[2] ?? "0"),
        currency: CODE_TO_CURRENCY[(m[1] ?? "").toLowerCase()] ?? "",
        text: m[0],
      },
      m[0].length,
    );
  }
  for (const m of text.matchAll(AMOUNT_WORD)) {
    push(
      {
        index: m.index,
        cents: toCents(m[1] ?? "0"),
        currency: CODE_TO_CURRENCY[(m[2] ?? "").toLowerCase()] ?? "",
        text: m[0],
      },
      m[0].length,
    );
  }
  for (const m of text.matchAll(WRITTEN)) {
    const dollars = wordsToNumber(m[1] ?? "");
    if (dollars === null) continue;
    const cents = m[3] ? (wordsToNumber(m[3]) ?? 0) : 0;
    push(
      {
        index: m.index,
        cents: dollars * 100 + cents,
        currency: CODE_TO_CURRENCY[(m[2] ?? "").toLowerCase()] ?? "",
        text: m[0],
      },
      m[0].length,
    );
  }
  for (const m of text.matchAll(BARE_AFTER_MONEY_WORD)) {
    const n = m[2] ?? "";
    const index = m.index + m[0].lastIndexOf(n);
    push({ index, cents: toCents(n), currency: "", text: n }, n.length);
  }
  return out;
}

// Role words: the nearest one in the same clause decides what an amount claims to be.
const ROLE_WORDS: [RegExp, AmountRole | "deposit" | "payment"][] = [
  [/\b(?:grand total|total|altogether|in all|overall|all[- ]in|comes? to|in total)\b/gi, "total"],
  [/\bsubtotal|before tax(?:es)?\b/gi, "subtotal"],
  [/\btax(?:es)?\b/gi, "tax"],
  [
    /\b(?:deliver(?:y|ing|ed)?|drop[- ]off|travel fee|mileage|shipping|set[- ]?up fee)\b/gi,
    "delivery",
  ],
  [/\b(?:deposit|down payment)\b/gi, "deposit"],
  [/\b(?:from|starting at|starts at|starting from|as low as|begins? at)\s*$/gi, "starting_price"],
  [/\b(?:discount|off)\b/gi, "discount"],
];

function roleOf(clause: string, offset: number): AmountRole | "deposit" | "any" {
  const before = clause.slice(Math.max(0, offset - 24), offset);
  if (/\b(?:from|starting at|starts at|starting from|as low as|begins? at)\s*$/i.test(before)) {
    return "starting_price";
  }
  let best: { d: number; role: AmountRole | "deposit" } | null = null;
  for (const [re, role] of ROLE_WORDS) {
    if (role === "starting_price" || role === "payment") continue;
    for (const m of clause.matchAll(re)) {
      const d = Math.abs(m.index - offset);
      if (!best || d < best.d) best = { d, role };
    }
  }
  return best?.role ?? "any";
}

// ── subjects: products and dates named in a sentence ─────────────────────────

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface DateMention {
  iso?: string;
  month?: number;
  day?: number;
  weekday?: number;
}

function dateMentions(text: string): DateMention[] {
  const out: DateMention[] = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push({ iso: m[0] });
  const month = `(${MONTHS.map((x) => x.slice(0, 3)).join("|")})[a-z]*\\.?`;
  for (const m of text.matchAll(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"))) {
    out.push({
      month: MONTHS.findIndex((x) => x.startsWith((m[1] ?? "").toLowerCase())) + 1,
      day: Number(m[2]),
    });
  }
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month}`, "gi"),
  )) {
    out.push({
      month: MONTHS.findIndex((x) => x.startsWith((m[2] ?? "").toLowerCase())) + 1,
      day: Number(m[1]),
    });
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) {
    out.push({ month: Number(m[1]), day: Number(m[2]) });
  }
  for (const m of text.matchAll(
    /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?s?\b/gi,
  )) {
    const w = WEEKDAYS.findIndex((x) => x.startsWith((m[1] ?? "").toLowerCase().slice(0, 3)));
    if (w >= 0) out.push({ weekday: w });
  }
  return out;
}

function dateMatches(mention: DateMention, isoDates: string[]): boolean {
  return isoDates.some((iso) => {
    const [y, mo, d] = iso.split("-").map(Number) as [number, number, number];
    if (mention.iso) return mention.iso === iso;
    if (mention.weekday !== undefined) {
      return new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === mention.weekday;
    }
    return mention.month === mo && mention.day === d;
  });
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function productsNamed(sentence: string, known: string[]): string[] {
  const s = ` ${norm(sentence)} `;
  return known.filter((p) => {
    const n = norm(p);
    return n.length > 0 && s.includes(` ${n} `);
  });
}

/** Capitalised multi-word names that are not a known product: an unrecognised subject. */
function unknownSubjects(sentence: string, known: string[], businessName: string): string[] {
  const allowed = [...known, businessName].map(norm);
  const out: string[] = [];
  for (const m of sentence.matchAll(/\b[A-Z][a-z0-9']+(?:\s+[A-Z][a-z0-9']+)+\b/g)) {
    const n = norm(m[0]);
    const words = n.split(" ");
    if (words.every((w) => MONTHS.includes(w) || WEEKDAYS.includes(w) || w.length <= 2)) continue;
    if (allowed.some((a) => a.includes(n) || n.includes(a))) continue;
    if (/^(good news|great news|the team|thank you|thanks|no problem)$/.test(n)) continue;
    out.push(m[0]);
  }
  return out;
}

// ── clause helpers ───────────────────────────────────────────────────────────

/** Words that negate the claim right after them ("not available", "nothing has been paid"). */
const NEGATOR =
  /^(?:not|no|never|nothing|none|nor|without|cannot|can't|cant|isn't|aren't|wasn't|weren't|won't|don't|doesn't|didn't|haven't|hasn't|hadn't|yet)$/;
/**
 * Conditional grammar, decided PER CLAIM (ADR 0017 §19–20). A claim is hypothetical only when:
 * - it is the antecedent's own predicate: its clause opens with a subordinating condition ("if",
 *   "unless", "whether", "once" — not "once again/more" —, "when", "provided", "assuming", "as
 *   soon as", "in case") and no other verb stands between that marker and the claim's own
 *   auxiliary chain ("If the quote is confirmed"; NOT "If you're wondering your booking is…"); or
 * - it is a consequence of a condition opened earlier in the sentence AND its OWN auxiliary chain
 *   — the verbs immediately governing the state word — is modal/future ("it WILL BE booked",
 *   "it CAN BE booked"). A modal of another, later predicate ("…is confirmed and you can relax")
 *   never reaches back to an earlier present-tense claim.
 * Words that are also adjectives ("pending", "before", "after") are conditions only as a fronted
 * phrase: "Pending bookings are confirmed." is an assertion.
 */
const STRONG_MARKER =
  /^\s*(?:(?:and|but|so|or|then|only)\s+)?(?:if|unless|whether|once(?!\s+(?:again|more)\b)|when|whenever|provided(?:\s+that)?|assuming(?:\s+that)?|as\s+soon\s+as|in\s+case)\b/i;
const WEAK_MARKER = /^\s*(?:(?:and|but|so|or|then|only)\s+)?(?:pending|before|after|until|upon)\b/i;
const AUX_WORDS = new Set(
  "am is are was were be been being have has had do does did get gets got getting".split(" "),
);
const MODAL_WORDS = new Set("will would can could may might shall should must".split(" "));
/** Words that may sit inside an auxiliary chain without ending it. */
const CHAIN_FILLER = new Set(
  "not never now already also still just officially fully definitely currently temporarily all both each".split(
    " ",
  ),
);
const isContractedVerb = (t: string) => /'(?:re|s|ve|ll|d|m)$/i.test(t);
const isVerbToken = (t: string) => {
  const l = t.toLowerCase();
  return AUX_WORDS.has(l) || MODAL_WORDS.has(l) || isContractedVerb(l) || /ing$/.test(l);
};

/**
 * The auxiliary chain governing the state word at the end of `tokens` (walking back over verbs,
 * modals, negators/adverbs and count material): where it starts, and whether it is modal/future.
 */
function auxChain(tokens: string[]): { start: number; modal: boolean } {
  let i = tokens.length - 1;
  let modal = false;
  while (i >= 0) {
    const l = (tokens[i] ?? "").toLowerCase();
    if (MODAL_WORDS.has(l) || /'(?:ll|d)$/.test(l)) {
      modal = true;
      i--;
    } else if (AUX_WORDS.has(l) || isContractedVerb(l) || CHAIN_FILLER.has(l) || isCountToken(l)) {
      i--;
    } else break;
  }
  return { start: i + 1, modal };
}
const isCountToken = (t: string) =>
  /^\d{1,3}(?:,\d{3})+$|^\d+$/.test(t) ||
  t
    .toLowerCase()
    .split("-")
    .every((w) => w in UNITS || w in SCALES);

function clauseAt(sentence: string, index: number): { text: string; offset: number } {
  // Not ":" — times ("12:00") would split a clause.
  const separators = /[,;]|\s(?:but|however|although|though|whereas|while)\s|\s-\s|\s—\s/gi;
  let start = 0;
  let end = sentence.length;
  for (const m of sentence.matchAll(separators)) {
    if (m.index < index) start = m.index + m[0].length;
    else if (m.index >= index) {
      end = m.index;
      break;
    }
  }
  return { text: sentence.slice(start, end), offset: index - start };
}

/**
 * Negated or hypothetical — decided LOCALLY: a negator among the three words right before the
 * claim, or a condition opening its clause. A leading "No worries" or "No problem" several words
 * earlier negates nothing.
 */
/**
 * Conversational fillers that contain a negator but negate nothing ("No worries, your booking is
 * confirmed"). They are blanked out (same length, so positions stay valid) before any claim is
 * evaluated, so they can never make a following claim look negated.
 */
const FILLER =
  /\b(?:no worries|no worry|not to worry|no need to worry|nothing to worry about|no problem|no problems|not a problem|no probs?|no prob|no stress|no rush|no doubt|no sweat|never mind|no matter)\b/gi;
export function blankFillers(text: string): string {
  return text.replace(FILLER, (m) => " ".repeat(m.length));
}

export function hypothetical(sentence: string, index: number): boolean {
  const { text, offset } = clauseAt(sentence, index);
  const clauseStart = index - offset;
  const before = text.slice(0, offset);
  const tokens = before.match(/[A-Za-z0-9][A-Za-z0-9'-]*(?:,\d{3})*/g) ?? [];
  const chain = auxChain(tokens);
  const marker = STRONG_MARKER.exec(before);
  if (marker) {
    // The antecedent's own predicate: nothing verbal between the marker and the claim's chain.
    const markerTokens = (marker[0].match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? []).length;
    if (!tokens.slice(markerTokens, chain.start).some(isVerbToken)) return true;
    // A consequence in the same clause ("If the quote is confirmed it will be booked").
    return chain.modal;
  }
  // The consequence of a condition fronted in an earlier clause — only with its own modal chain.
  if (clauseStart > 0 && chain.modal) {
    const fronted = sentence.slice(0, clauseStart);
    if (STRONG_MARKER.test(fronted) || WEAK_MARKER.test(fronted)) return true;
  }
  return false;
}

function negated(sentence: string, index: number): boolean {
  if (hypothetical(sentence, index)) return true;
  const { text, offset } = clauseAt(sentence, index);
  const before = text.slice(0, offset);
  const words = before.toLowerCase().match(/[a-z']+/g) ?? [];
  return words.slice(-3).some((w) => NEGATOR.test(w) || w.endsWith("n't"));
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── subjects: times, quantities and quote numbers named in a sentence ────────

/** Clock times as minutes after midnight: "20:00", "8 PM", "8:30pm", "noon", "midnight". */
function timeMentions(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi)) {
    let h = Number(m[1]) % 12;
    if ((m[3] ?? "").toLowerCase().startsWith("p")) h += 12;
    out.push(h * 60 + Number(m[2] ?? 0));
  }
  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:a\.?m|p\.?m))/gi)) {
    out.push(Number(m[1]) * 60 + Number(m[2]));
  }
  if (/\bnoon\b/i.test(text)) out.push(12 * 60);
  if (/\bmidnight\b/i.test(text)) out.push(0);
  return out;
}

const minutesOf = (hhmm: string | undefined) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function withinWindow(t: number, start: number, end: number): boolean {
  return end > start ? t >= start && t <= end : t >= start || t <= end;
}

/**
 * ONE canonical quantity parser (all syntaxes yield the same integer): digits with or without
 * thousands separators ("1000", "1,000"), written numbers ("one thousand", "twenty five",
 * "twenty-five", "five hundred") and dozens ("a dozen", "two dozen").
 */
const QTY_WORD = `(?:${NUMBER_WORD.slice(3, -1)}|dozens?)`;
const QTY_NUMBER = `(?:\\d{1,3}(?:,\\d{3})+(?!\\d)|\\d+(?!\\d)|${QTY_WORD}(?:[\\s-]+${QTY_WORD})*)`;

export function parseQuantity(raw: string): number | null {
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/\bhalf a dozen\b/g, "six");
  if (/^\d{1,3}(?:,\d{3})+$/.test(t) || /^\d+$/.test(t)) {
    const n = Number(t.replace(/,/g, ""));
    return Number.isSafeInteger(n) ? n : null;
  }
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of t.split(/[\s-]+/)) {
    if (w === "and") continue;
    if (w === "a") current = Math.max(current, 1);
    else if (w === "dozen" || w === "dozens") current = Math.max(current, 1) * 12;
    else if (w in UNITS) current += UNITS[w] ?? 0;
    else if (w === "hundred") current = Math.max(current, 1) * 100;
    else if (w in SCALES) {
      total += Math.max(current, 1) * (SCALES[w] ?? 1);
      current = 0;
    } else return null;
    if (w !== "a") seen = true;
  }
  return seen ? total + current : null;
}

const QTY_PREFIX = new RegExp(
  `\\b(?:quantity|qty|quantities)\\.?\\s*(?:of\\s+|:\\s*|=\\s*|is\\s+|was\\s+)?(${QTY_NUMBER})(?![a-z])`,
  "gi",
);
const QTY_SUFFIX = new RegExp(
  `(?<![\\w,])(${QTY_NUMBER})\\s*(?:units?|of them|of those|pieces?|pcs|items?|sets?|copies|×|x)(?![a-z])`,
  "gi",
);
const QTY_DOZEN = new RegExp(
  `\\b(?:half a|${QTY_WORD}(?:[\\s-]+${QTY_WORD})*)\\s+dozens?\\b`,
  "gi",
);

/**
 * Quantities of the item itself ("500 units", "quantity 1,000", "qty twenty-five", "a dozen"),
 * not guest counts. Every mention goes through parseQuantity; overlapping syntaxes count once.
 */
function quantityMentions(text: string): number[] {
  const out: number[] = [];
  const taken: [number, number][] = [];
  const add = (index: number, length: number, raw: string) => {
    if (taken.some(([s, e]) => index < e && index + length > s)) return;
    const n = parseQuantity(raw);
    if (n === null || n <= 0) return;
    taken.push([index, index + length]);
    out.push(n);
  };
  for (const m of text.matchAll(QTY_PREFIX)) add(m.index, m[0].length, m[1] ?? "");
  for (const m of text.matchAll(QTY_SUFFIX)) add(m.index, m[0].length, m[1] ?? "");
  for (const m of text.matchAll(QTY_DOZEN)) add(m.index, m[0].length, m[0]);
  return out;
}

const QUOTE_NUMBER = /\b[A-Z][A-Z0-9]{0,7}-\d{1,9}\b/g;

// ── the subjects of a sentence, parsed whole (no word window) ─────────────────

/** Words a plural transactional subject may contain besides counts and quote numbers. */
const SUBJECT_WORDS = new Set(
  (
    "all both each every of the your my our these those its their this that a an and or " +
    "quote quotes booking bookings reservation reservations request requests hold holds order orders " +
    "them they they're you " +
    "current other remaining pending confirmed held booked active requested new existing previous " +
    "open recent latest earlier submitted same rental party event reserved " +
    "yes great good news so now okay ok also then sure perfect done"
  ).split(" "),
);
const QUANTIFIERS = new Set(["all", "both", "each", "every"]);
const PLURAL_TOKENS = new Set([
  "quotes",
  "bookings",
  "reservations",
  "requests",
  "holds",
  "orders",
  "them",
  "they",
  "they're",
  "these",
  "those",
]);
/** A subject ends at its verb. */
const VERBS = new Set(
  "is are was were be been being have has had will would can could may might do does did get got remain remains stay stays look looks".split(
    " ",
  ),
);
/** Plural wording outside the subject ("they are BOTH booked", "are ALL confirmed"). */
const PLURAL_WORD =
  /\b(?:both|each of (?:them|these|those|the)|all of (?:them|these|those|the)|every one|each one|all (?!set\b)(?:\w+ )?(?:are|were|have|is)|are all|they|they're|them|these|those)\b/i;
const CLAUSE_SEPARATOR =
  /;|,(?!\d{3}\b)|(?<!\d):(?!\d)|\s[-—]\s|\s(?:but|however|although|though|whereas|while)\s/gi;
const TOKEN = /[A-Za-z0-9][A-Za-z0-9'-]*(?:,\d{3})*/g;

const isQuoteNumberToken = (t: string) => /^[A-Z][A-Z0-9]{0,7}-\d{1,9}$/.test(t);
const isNumberToken = (t: string) =>
  /^\d{1,3}(?:,\d{3})+$|^\d+$/.test(t) ||
  t
    .toLowerCase()
    .split("-")
    .every((w) => w in UNITS || w in SCALES || w === "dozen" || w === "dozens");

export interface SubjectShape {
  plural: boolean;
  count: number | null;
  unresolved: boolean;
}

/**
 * One clause's subject — ALL its tokens from the clause start up to its first verb, however many
 * — read token by token. When the subject is plural (a quantifier, a plural noun or pronoun, or
 * several quote numbers), EVERY token must be understood: a quote number, a count (a run of
 * number words or digits read together by the canonical parser: "twenty one", "one hundred and
 * one", "1,000"), or a known determiner/modifier/noun. Anything else ("umpteen", "several",
 * "currently", "very important") makes it UNRESOLVED — the claim fails closed.
 */
function clauseSubject(clause: string): { plural: boolean; counts: number[]; unresolved: boolean } {
  const all = clause.match(TOKEN) ?? [];
  const verbAt = all.findIndex((t) => VERBS.has(t.toLowerCase()));
  const tokens = verbAt < 0 ? all : all.slice(0, verbAt);
  const lower = tokens.map((t) => t.toLowerCase());
  const plural =
    lower.some((t) => QUANTIFIERS.has(t) || PLURAL_TOKENS.has(t)) ||
    tokens.filter(isQuoteNumberToken).length > 1;
  const counts: number[] = [];
  let unresolved = false;
  if (lower.includes("both")) counts.push(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (isNumberToken(t)) {
      let j = i + 1;
      while (
        j < tokens.length &&
        (isNumberToken(tokens[j] ?? "") ||
          (/^(?:and|a)$/i.test(tokens[j] ?? "") && isNumberToken(tokens[j + 1] ?? "")))
      ) {
        j++;
      }
      const n = parseQuantity(tokens.slice(i, j).join(" "));
      if (n === null) unresolved = true;
      else counts.push(n);
      i = j - 1;
    } else if (plural && !isQuoteNumberToken(t) && !SUBJECT_WORDS.has(t.toLowerCase())) {
      unresolved = true;
    }
  }
  if (lower.some((t) => QUANTIFIERS.has(t)) && counts.some((c) => c < 2)) unresolved = true;
  return { plural, counts, unresolved };
}

/**
 * How many quotes — and whether several — a sentence's claims are about. Every clause's COMPLETE
 * subject is parsed (no word or modifier limit), plus plural wording and "all <count>" anywhere
 * ("they are both booked", "they are all eleven booked"). A stated count never disappears: it is
 * read, or the subject is UNRESOLVED (unreadable count, counts that disagree, a quantifier with
 * fewer than two) — and an unresolved claim is rejected.
 */
export function subjectShape(sentence: string): SubjectShape {
  const counts: number[] = [];
  let plural = PLURAL_WORD.test(sentence);
  let unresolved = false;
  let start = 0;
  const pieces: string[] = [];
  for (const m of sentence.matchAll(CLAUSE_SEPARATOR)) {
    pieces.push(sentence.slice(start, m.index));
    start = m.index + m[0].length;
  }
  pieces.push(sentence.slice(start));
  for (const piece of pieces) {
    const c = clauseSubject(piece);
    plural ||= c.plural;
    unresolved ||= c.unresolved;
    counts.push(...c.counts);
  }
  if (/\bboth\b/i.test(sentence)) counts.push(2);
  // "… are all eleven booked": a count right after "all", outside the subject.
  const tokens = sentence.match(TOKEN) ?? [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i]?.toLowerCase() !== "all" || !isNumberToken(tokens[i + 1] ?? "")) continue;
    let j = i + 2;
    while (j < tokens.length && isNumberToken(tokens[j] ?? "")) j++;
    const n = parseQuantity(tokens.slice(i + 1, j).join(" "));
    if (n === null || n < 2) unresolved = true;
    else counts.push(n);
  }
  const distinct = [...new Set(counts)];
  if (distinct.length > 1) unresolved = true;
  const count = distinct[0] ?? null;
  return { plural: plural || (count ?? 0) >= 2 || unresolved, count, unresolved };
}

/** Adverbs that may sit between the verb and the state ("are now all officially booked"). */
const PREDICATE_WORDS = new Set(
  "now officially fully already also definitely still currently temporarily just".split(" "),
);

/**
 * The span between a claim's auxiliary verb and its state word — "They are [all of the eleven
 * quotes] confirmed", "They are [all umpteen] booked" — parsed whole. When it carries quantifier
 * or count material, every token must be understood (a count read by the canonical parser, a
 * quote number, a known determiner/modifier/noun/adverb); otherwise the subject is UNRESOLVED.
 */
export function predicateSpan(sentence: string, stateAt: number): SubjectShape {
  // The claim's clause, from its start (after the last separator) to the state word.
  let clauseStart = 0;
  for (const m of sentence.slice(0, stateAt).matchAll(CLAUSE_SEPARATOR)) {
    clauseStart = m.index + m[0].length;
  }
  const tokens = sentence.slice(clauseStart, stateAt).match(TOKEN) ?? [];
  // Anchored at the clause's FIRST verb (the outer assertion's), never a later one: a relative
  // clause's "have been" must not erase "all of the eleven quotes" before it.
  const first = tokens.findIndex((t) => {
    const l = t.toLowerCase();
    return VERBS.has(l) || l.endsWith("'re") || l.endsWith("'s");
  });
  let span = first < 0 ? [] : tokens.slice(first + 1);
  // Drop the claim's own trailing auxiliary chain ("… quotes that HAVE NOW BEEN confirmed").
  let end = span.length;
  while (end > 0) {
    const l = (span[end - 1] ?? "").toLowerCase();
    if (
      AUX_WORDS.has(l) ||
      MODAL_WORDS.has(l) ||
      isContractedVerb(l) ||
      PREDICATE_WORDS.has(l) ||
      l === "not" ||
      l === "never"
    ) {
      end--;
    } else break;
  }
  span = span.slice(0, end);
  const lower = span.map((t) => t.toLowerCase());
  const material = lower.some((t) => QUANTIFIERS.has(t)) || span.some(isNumberToken);
  if (!material) return { plural: false, count: null, unresolved: false };
  // Count material with a relative clause or another verb inside ("are all of the eleven quotes
  // THAT HAVE been confirmed"): the parser cannot bind the count to the claim — fail closed.
  if (span.some((t) => /^(?:that|which|who|whom|whose)$/i.test(t) || isVerbToken(t))) {
    return { plural: true, count: null, unresolved: true };
  }
  const counts: number[] = [];
  let unresolved = false;
  if (lower.includes("both")) counts.push(2);
  for (let i = 0; i < span.length; i++) {
    const t = span[i] ?? "";
    if (isNumberToken(t)) {
      let j = i + 1;
      while (
        j < span.length &&
        (isNumberToken(span[j] ?? "") ||
          (/^(?:and|a)$/i.test(span[j] ?? "") && isNumberToken(span[j + 1] ?? "")))
      ) {
        j++;
      }
      const n = parseQuantity(span.slice(i, j).join(" "));
      if (n === null) unresolved = true;
      else counts.push(n);
      i = j - 1;
    } else if (
      !isQuoteNumberToken(t) &&
      !SUBJECT_WORDS.has(t.toLowerCase()) &&
      !PREDICATE_WORDS.has(t.toLowerCase())
    ) {
      unresolved = true;
    }
  }
  const distinct = [...new Set(counts)];
  if (distinct.length > 1) unresolved = true;
  const count = distinct[0] ?? null;
  if (lower.some((t) => QUANTIFIERS.has(t)) && count !== null && count < 2) unresolved = true;
  return { plural: true, count, unresolved };
}

/** Two readings of the same claim: plurality and unresolved-ness add up; counts must agree. */
function mergeShapes(a: SubjectShape, b: SubjectShape): SubjectShape {
  const counts = [...new Set([a.count, b.count].filter((c): c is number => c !== null))];
  return {
    plural: a.plural || b.plural,
    count: counts[0] ?? null,
    unresolved: a.unresolved || b.unresolved || counts.length > 1,
  };
}

// ── claim patterns ───────────────────────────────────────────────────────────

/** Positive availability wording (bare "available" included: "Party Slide: available Saturday"). */
const AVAILABLE_CLAIM =
  /\b(?:available|in stock|bookable|(?:is|are|'s|'re|remains?|looks?)\s+(?:still\s+|currently\s+|now\s+)?open(?!\s+(?:the|a|an|your|this|that))|availability (?:is|looks) (?:good|fine|confirmed|clear|open|great)|(?:we|i) (?:have|got|can get) (?:it|them|one|that|this|those|these) (?:for|on)|(?:that date|the date|your date|that day|that time) (?:works|is open|is free))\b/gi;
/** "Options/sizes available" describes the catalog, not a date — unless a date/time/quantity is named. */
const CATALOG_AVAILABLE =
  /\b(?:options?|products?|rentals?|items?|choices?|sizes?|colou?rs?|variants?|add-ons?|models?|themes?)\s+(?:\w+\s+){0,2}$/i;
const GUARANTEE_CLAIM =
  /\b(?:guarantee[ds]?|guaranteeing|promise[ds]?|100% (?:available|sure)|definitely yours)\b/gi;
const BOOKED_CLAIM =
  /\b(?:(?:is|are|'s|'re|been|be|now|all|got|get)\s+(?:(?:now|officially|fully|already|both|all|each|also|definitely)\s+){0,2}(?:booked|confirmed|reserved|secured|locked in|finali[sz]ed|all set)|you(?:'re| are) (?:all )?set|(?:i|we)(?:'ve| have)?\s+(?:booked|reserved|secured|locked in|locked)|(?:i|we)(?:'ve| have)? confirmed (?:your|the) (?:booking|reservation|date|event|rental|order)|(?:booking|reservation|order|rental) (?:is |has been )?(?:complete|completed|done|confirmed|finali[sz]ed|secured|locked)|(?:date|slot|spot|event) (?:is |has been )(?:reserved|secured|saved|locked|booked|confirmed)|reserved for you|it'?s (?:all )?yours|(?:booked|reserved|secured) (?:for|on|it|them|everything))\b/gi;
const HOLD_CLAIM =
  /\b(?:(?:is|are|being|been|now|temporarily)\s+(?:temporarily\s+)?(?:held|on hold)|holding (?:it|them|the items|your|everything|the inventory)|placed (?:a|the) hold|hold (?:is|has been|was) placed|held for (?:you|\d+)|held until)\b/gi;
const DELIVERY_CLAIM =
  /\b(?:(?:we|i|they)\s+(?:can |will |do |'ll )?deliver\b(?!y)|deliver(?:y|ing)? (?:to|at) (?:your|that|the|this) (?:address|area|location|place|home|park|venue)|(?:in|within|inside) (?:our|the|their) (?:service|delivery) (?:area|zone|radius)|delivery is (?:available|possible|fine|no problem)|(?:we|they) (?:serve|cover) (?:your|that|the)|(?:your|that|the) (?:address|area|zip|location) is (?:covered|served|serviceable|in range))/gi;
const TAX_CLAIM =
  /\b(?:tax(?:es)? (?:is |are )?(?:already )?(?:included|includes|in there|built in|covered|waived|zero)|including (?:all )?tax(?:es)?|tax(?:es)? inclusive|tax[- ]free|(?:no|without) (?:sales )?tax(?:es)?)\b/gi;
const PAYMENT_CLAIM =
  /\b(?:paid|payment (?:is |has been |was )?(?:received|complete|completed|processed|made|taken|confirmed|successful|done)|charged (?:your|the) card|card (?:has been|was|is) charged|(?:you(?:'ve| have)|you were) (?:been )?(?:charged|billed)|deposit (?:has been |was |is )?(?:received|taken|collected)|prepaid)\b/gi;

/**
 * THE booking/hold state vocabulary (ADR 0017 §19). Grounding's state predicates and replay's
 * time-sensitivity are both built from this one table, so a state grounding accepts can never be
 * replayed as stored prose: `booked` and `held` words are claims checked against evidence; every
 * word of every list marks a reply time-sensitive.
 */
export const BOOKING_STATE_WORDS = {
  booked: ["booked", "confirmed", "reserved", "secured", "finalized", "finalised", "locked in"],
  held: ["held", "on hold"],
  status: ["declined", "cancelled", "canceled", "pending", "released", "awaiting", "expired"],
} as const;
const wordsRegex = (list: readonly string[], flags: string) =>
  new RegExp(`\\b(?:${list.map((w) => w.replace(/ /g, "\\s+")).join("|")})\\b`, flags);
const BOOKED_STATE = wordsRegex(BOOKING_STATE_WORDS.booked, "gi");
const HELD_STATE = wordsRegex(BOOKING_STATE_WORDS.held, "gi");
const BE_VERB = /\b(?:is|are|was|were|be|been|being)\b|'s\b|'re\b/i;

/**
 * Booking/hold STATE predicates, found without any word window: every phrase-pattern match, and
 * every state word with a form of "be" anywhere before it in the sentence ("they are all eleven
 * booked"). `at` is where negation is judged; `stateAt` is the state word itself (where the
 * post-verb span ends).
 */
function statePredicates(
  sentence: string,
  state: RegExp,
  phrases: RegExp,
): { at: number; stateAt: number }[] {
  const out = new Map<number, { at: number; stateAt: number }>();
  const single = new RegExp(state.source, "i");
  for (const m of sentence.matchAll(phrases)) {
    const inner = single.exec(m[0]);
    const stateAt = m.index + (inner ? inner.index : 0);
    out.set(stateAt, { at: m.index, stateAt });
  }
  for (const m of sentence.matchAll(state)) {
    if (BE_VERB.test(sentence.slice(0, m.index)) && !out.has(m.index)) {
      out.set(m.index, { at: m.index, stateAt: m.index });
    }
  }
  return [...out.values()].sort((x, y) => x.stateAt - y.stateAt);
}

/**
 * Stable violation codes. Telemetry and logs carry ONLY these — never the reply's prose, which can
 * contain names, emails or addresses.
 */
export const GROUNDING_CODES = [
  "GROUNDING_PAYMENT_UNSUPPORTED",
  "GROUNDING_GUARANTEE_UNSUPPORTED",
  "GROUNDING_DEPOSIT_UNSUPPORTED",
  "GROUNDING_CURRENCY_MISMATCH",
  "GROUNDING_SUBJECT_UNKNOWN",
  "GROUNDING_AMOUNT_UNSUPPORTED",
  "GROUNDING_AMOUNT_ROLE_MISMATCH",
  "GROUNDING_AVAILABILITY_UNSUPPORTED",
  "GROUNDING_AVAILABILITY_SCOPE_MISMATCH",
  "GROUNDING_QUOTE_UNKNOWN",
  "GROUNDING_BOOKING_STATUS_UNSUPPORTED",
  "GROUNDING_HOLD_UNSUPPORTED",
  "GROUNDING_DELIVERY_UNSUPPORTED",
  "GROUNDING_TAX_UNSUPPORTED",
] as const;
export type GroundingCode = (typeof GROUNDING_CODES)[number];

// ── evidence selection ───────────────────────────────────────────────────────

function fresh<K extends Evidence["kind"]>(input: GroundingInput, kind: K): EvidenceOf<K>[] {
  return input.evidence.filter((e): e is EvidenceOf<K> => e.kind === kind && isFresh(e, input.now));
}

/** The most recent fresh item satisfying `fits` (list order = time order). */
function latest<K extends Evidence["kind"]>(
  input: GroundingInput,
  kind: K,
  fits: (e: EvidenceOf<K>) => boolean = () => true,
): EvidenceOf<K> | null {
  const list = fresh(input, kind).filter(fits);
  return list.at(-1) ?? null;
}

function pricedAmounts(
  input: GroundingInput,
  products: string[],
  dates: DateMention[],
): { role: AmountRole; cents: number; currency: string }[] {
  const subjectFits = (e: { products: string[]; dates: string[] }) =>
    products.every((p) => e.products.some((x) => norm(x) === norm(p))) &&
    dates.every((d) => dateMatches(d, e.dates));
  const out: { role: AmountRole; cents: number; currency: string }[] = [];
  // Only the CURRENT price (the newest one matching the subject) and the current quote count:
  // a newer price for the same subject supersedes older ones.
  const price = latest(input, "price", subjectFits);
  if (price && price.status === "priced") {
    for (const a of price.amounts) out.push({ ...a, currency: price.currency });
    const taxes = price.amounts.filter((a) => a.role === "tax");
    if (taxes.length > 1) {
      out.push({
        role: "tax",
        cents: taxes.reduce((s, a) => s + a.cents, 0),
        currency: price.currency,
      });
    }
  }
  const quote = latest(input, "quote", subjectFits);
  if (quote?.priceIsFinal)
    for (const a of quote.amounts) out.push({ ...a, currency: quote.currency });
  const area = latest(input, "service_area");
  if (area?.status === "serviceable" && area.feeCents !== null) {
    out.push({ role: "delivery", cents: area.feeCents, currency: area.currency });
  }
  return out;
}

function catalogAmounts(input: GroundingInput, products: string[]) {
  return fresh(input, "catalog_price")
    .filter((e) => products.length === 0 || products.some((p) => norm(p) === norm(e.productName)))
    .flatMap((e) => e.amounts.map((a) => ({ ...a, currency: e.currency })));
}

/** A hold's server message is trustworthy only while the hold itself is live and long enough. */
function liveHold(b: EvidenceOf<"booking">, now: Date): boolean {
  if (b.status !== "hold_placed" && b.status !== "holding") return false;
  if (!b.holdExpiresAt) return false;
  const remaining = (Date.parse(b.holdExpiresAt) - now.getTime()) / 60_000;
  if (!(remaining > 0)) return false;
  const stated = /\bfor (\d+) minutes?\b/i.exec(b.message);
  return !stated || Number(stated[1]) <= Math.ceil(remaining) + 1;
}

// ── the check ────────────────────────────────────────────────────────────────

export function checkGrounding(input: GroundingInput): GroundingResult {
  // Exempt verbatim: the fixed manual-review sentence, and typed booking messages whose state is
  // still true now (a refusal/confirmation as recorded; a hold only while it is actually live).
  const violations = new Set<GroundingCode>();
  const flag = (code: GroundingCode) => {
    violations.add(code);
  };
  // Typographic apostrophes and quotes behave like plain ones ("you’re booked"); conversational
  // fillers ("No worries") are neutralised before anything is evaluated.
  let text = blankFillers(input.reply.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'));

  // Exempt verbatim: the fixed manual-review sentence, and typed booking messages whose state is
  // still true now. A booking message is about ONE quote: it stays exempt only where the quote it
  // is attributed to in the reply (the nearest quote number before it, or any in its sentence) is
  // that message's own quote. Otherwise it is evaluated like any other prose.
  const exemptFixed = (input.exemptSentences ?? []).filter((s) => s.length > 0);
  for (const s of exemptFixed) text = text.split(s).join(" ".repeat(s.length));
  const scoped = fresh(input, "booking")
    .filter((b) => b.status === "refused" || b.status === "confirmed" || liveHold(b, input.now))
    .filter((b) => b.message.length > 0)
    .sort((a, b) => b.message.length - a.message.length);
  // The quote SET a stretch of the reply is about: the numbers named in its own sentence, or else
  // all numbers of the nearest earlier sentence that names any.
  const sentenceBounds = (at: number, end: number) => {
    const before = text.slice(0, at);
    const starts = [...before.matchAll(/[.!?](?:\s|$)|\n/g)];
    const start = starts.length
      ? (starts.at(-1)?.index ?? 0) + (starts.at(-1)?.[0].length ?? 0)
      : 0;
    const rest = text.slice(end).search(/[.!?](?:\s|$)|\n/);
    return { start, stop: rest < 0 ? text.length : end + rest };
  };
  const carriedNumbers = (upTo: number): string[] => {
    for (const earlier of sentencesOf(text.slice(0, upTo)).reverse()) {
      const named = [...earlier.matchAll(QUOTE_NUMBER)].map((m) => m[0]);
      if (named.length) return named;
    }
    return [];
  };
  for (const b of scoped) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(b.message, from);
      if (at < 0) break;
      from = at + b.message.length;
      // The whole subject set this message is attributed to must be the message's own quote: an
      // exemption never erases the other subjects ("Quotes Q-2 and Q-1: This booking is
      // confirmed" is about Q-2 as well) and never covers plural wording ("Both quotes: …").
      const { start, stop } = sentenceBounds(at, from);
      const around = `${text.slice(start, at)} ${text.slice(from, stop)}`;
      const inSentence = [...around.matchAll(QUOTE_NUMBER)].map((m) => m[0]);
      const attributed = inSentence.length ? inSentence : carriedNumbers(start);
      if (!subjectShape(around).plural && attributed.every((n) => n === b.quoteNumber)) {
        text = text.slice(0, at) + " ".repeat(b.message.length) + text.slice(from);
      }
    }
  }
  const knownQuotes = new Set(
    fresh(input, "quote")
      .map((q) => q.quoteNumber)
      .concat(fresh(input, "booking").map((b) => b.quoteNumber)),
  );

  let carried: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const question = sentence.endsWith("?");
    const products = productsNamed(sentence, input.knownProducts);
    const dates = dateMentions(sentence);
    const times = timeMentions(sentence);
    const quantities = quantityMentions(sentence);
    const quoteNumbers = [...sentence.matchAll(QUOTE_NUMBER)].map((m) => m[0]);
    // Quote numbers of the nearest earlier sentence naming any (the subject an unnumbered claim
    // continues).
    const earlier = carried;
    if (quoteNumbers.length) carried = quoteNumbers;
    const unknown = unknownSubjects(sentence, input.knownProducts, input.businessName);

    // A quote number the conversation never had is an invented reference.
    if (quoteNumbers.some((n) => !knownQuotes.has(n))) flag("GROUNDING_QUOTE_UNKNOWN");

    // Payments: never in M7.
    for (const m of sentence.matchAll(PAYMENT_CLAIM)) {
      if (!negated(sentence, m.index)) flag("GROUNDING_PAYMENT_UNSUPPORTED");
    }
    // Guarantees: availability is never guaranteed before the team confirms.
    for (const m of sentence.matchAll(GUARANTEE_CLAIM)) {
      if (!negated(sentence, m.index)) flag("GROUNDING_GUARANTEE_UNSUPPORTED");
    }

    // Amounts (questions too: "Would $300 work?" still states a number).
    const amounts = moneyMentions(sentence);
    for (const m of sentence.matchAll(FREE_WORDS)) {
      if (negated(sentence, m.index)) continue;
      amounts.push({ index: m.index, cents: 0, currency: "", text: m[0] });
    }
    for (const a of amounts) {
      const { text: clause, offset } = clauseAt(sentence, a.index);
      const role = roleOf(clause, offset);
      if (role === "deposit") {
        flag("GROUNDING_DEPOSIT_UNSUPPORTED");
        continue;
      }
      if (a.currency && a.currency !== input.currency.toUpperCase()) {
        flag("GROUNDING_CURRENCY_MISMATCH");
        continue;
      }
      if (unknown.length) {
        flag("GROUNDING_SUBJECT_UNKNOWN");
        continue;
      }
      const all =
        role === "starting_price"
          ? catalogAmounts(input, products)
          : pricedAmounts(input, products, dates);
      const pool =
        role === "any" || role === "starting_price" ? all : all.filter((x) => x.role === role);
      if (!pool.some((x) => x.cents === a.cents)) {
        flag(
          all.some((x) => x.cents === a.cents)
            ? "GROUNDING_AMOUNT_ROLE_MISMATCH"
            : "GROUNDING_AMOUNT_UNSUPPORTED",
        );
      }
    }

    if (question) continue;

    for (const m of sentence.matchAll(AVAILABLE_CLAIM)) {
      if (negated(sentence, m.index)) continue;
      const { text: clause, offset } = clauseAt(sentence, m.index);
      const specific = dates.length > 0 || times.length > 0 || quantities.length > 0;
      if (
        /^available$/i.test(m[0]) &&
        !specific &&
        CATALOG_AVAILABLE.test(clause.slice(0, offset))
      ) {
        continue; // "options available": a catalog statement, not an availability claim
      }
      if (unknown.length) {
        flag("GROUNDING_SUBJECT_UNKNOWN");
        break;
      }
      // The COMPLETE subject must match the latest result: product, date, time window, quantity.
      const subjects = products.length ? products : [null];
      const ok = subjects.every((p) => {
        const e = latest(
          input,
          "availability",
          (x) =>
            (p === null || norm(x.productName) === norm(p)) &&
            dates.every((d) => dateMatches(d, x.dates)) &&
            times.every((t) => {
              const start = minutesOf(x.startLocal);
              const end = minutesOf(x.endLocal);
              return start !== null && end !== null && withinWindow(t, start, end);
            }),
        );
        return e?.result === "available" && quantities.every((q) => q <= e.quantity);
      });
      if (!ok) {
        const anyForProduct = fresh(input, "availability").some(
          (x) => products.length === 0 || products.some((p) => norm(p) === norm(x.productName)),
        );
        flag(
          anyForProduct
            ? "GROUNDING_AVAILABILITY_SCOPE_MISMATCH"
            : "GROUNDING_AVAILABILITY_UNSUPPORTED",
        );
        break;
      }
    }

    // Booking and hold claims: EVERY asserted subject must be resolved and itself have the
    // claimed state. Subjects are the quotes named in the sentence; with none named, those of the
    // nearest earlier sentence naming any; plural wording ("both quotes", "all three bookings",
    // "they") with nothing named means every quote of this conversation — and must match any
    // stated count. One confirmed quote never authorises a claim about several; a plural claim
    // that cannot be resolved exactly is rejected (null subject).
    const subjectsOf = (stateAt: number): (EvidenceOf<"booking"> | null)[] => {
      // Resolution order (a null subject means UNRESOLVED, and the claim is rejected):
      //   1. quote numbers named in this sentence;
      //   2. quote numbers named in the nearest earlier sentence naming any;
      //   3. plural wording with nothing named → the conversation's whole quote set;
      //   4. the latest single booking — ONLY for a singular claim.
      // An explicitly plural claim never resolves to one booking: it needs 2+ concrete subjects,
      // an exact match with any stated count, and no unreadable count.
      // The sentence's subjects AND the claim's own post-verb span ("are [all of the eleven
      // quotes] confirmed"): neither can remove what the other found.
      const shape = mergeShapes(subjectShape(sentence), predicateSpan(sentence, stateAt));
      const bookingOf = (n: string) => latest(input, "booking", (b) => b.quoteNumber === n);
      if (shape.unresolved) return [null];
      const named = [...new Set(quoteNumbers.length ? quoteNumbers : earlier)];
      if (named.length) {
        if (shape.count !== null && shape.count !== named.length) return [null];
        if (shape.plural && named.length < 2) return [null];
        return named.map(bookingOf);
      }
      if (!shape.plural) return [latest(input, "booking")];
      const all = [...knownQuotes];
      if (all.length < 2) return [null];
      if (shape.count !== null && shape.count !== all.length) return [null];
      return all.map(bookingOf);
    };

    for (const p of statePredicates(sentence, BOOKED_STATE, BOOKED_CLAIM)) {
      if (negated(sentence, p.at)) continue;
      if (!subjectsOf(p.stateAt).every((b) => b?.status === "confirmed")) {
        flag("GROUNDING_BOOKING_STATUS_UNSUPPORTED");
        break;
      }
    }

    for (const p of statePredicates(sentence, HELD_STATE, HOLD_CLAIM)) {
      if (negated(sentence, p.at)) continue;
      const minutes = /\bfor (\d+) minutes?\b/i.exec(sentence);
      const ok = subjectsOf(p.stateAt).every((b) => {
        const remaining = b?.holdExpiresAt
          ? (Date.parse(b.holdExpiresAt) - input.now.getTime()) / 60_000
          : 0;
        const live =
          b !== null && (b.status === "hold_placed" || b.status === "holding") && remaining > 0;
        return live && !(minutes && Number(minutes[1]) > Math.ceil(remaining) + 1);
      });
      if (!ok) {
        flag("GROUNDING_HOLD_UNSUPPORTED");
        break;
      }
    }

    for (const m of sentence.matchAll(DELIVERY_CLAIM)) {
      if (negated(sentence, m.index)) continue;
      const area = latest(input, "service_area");
      const price = latest(input, "price");
      const ok =
        area?.status === "serviceable" ||
        (area === null && price?.status === "priced" && price.delivery === "priced");
      if (!ok) {
        flag("GROUNDING_DELIVERY_UNSUPPORTED");
        break;
      }
    }

    for (const m of sentence.matchAll(TAX_CLAIM)) {
      const phrase = m[0].toLowerCase();
      const saysNoTax = /tax[- ]free|(?:no|without) (?:sales )?tax|waived|zero/.test(phrase);
      if (!saysNoTax && negated(sentence, m.index)) continue;
      const price = latest(input, "price", (x) => x.status === "priced");
      const quote = latest(input, "quote", (x) => x.priceIsFinal);
      const amountsOf = (price ?? quote)?.amounts ?? [];
      const taxCents = amountsOf.filter((a) => a.role === "tax").reduce((s, a) => s + a.cents, 0);
      const ok = (price ?? quote) !== null && (saysNoTax ? taxCents === 0 : true);
      if (!ok) {
        flag("GROUNDING_TAX_UNSUPPORTED");
        break;
      }
    }
  }
  return { ok: violations.size === 0, violations: [...violations] };
}

// ── time-sensitive prose (replay) ────────────────────────────────────────────

/**
 * Any mention of a booking's status, in either polarity ("not confirmed yet" can become false):
 * EVERY word of the shared state table (so every state grounding recognises), plus the nouns.
 */
const BOOKING_STATUS_MENTION = wordsRegex(
  [
    ...BOOKING_STATE_WORDS.booked,
    ...BOOKING_STATE_WORDS.held,
    ...BOOKING_STATE_WORDS.status,
    "booking",
    "bookings",
    "confirmation",
    "reservation",
    "reservations",
    "hold",
    "holds",
    "holding",
    "all set",
  ],
  "i",
);

/**
 * Any availability statement, in either polarity ("available", "unavailable", "not available",
 * "sold out", "no availability", "is open"…): an old "unavailable" is as stale as an old
 * "available".
 */
const AVAILABILITY_MENTION =
  /\b(?:available|unavailable|availability|in stock|out of stock|sold out|booked up|fully booked|bookable|(?:is|are|'s|'re|remains?|looks?)\s+(?:still\s+|currently\s+|now\s+|not\s+)?(?:open|free)\b|(?:that|the|your) (?:date|day|time) (?:works|doesn't work|does not work))/i;

/**
 * Whether a stored reply states something TIME-SENSITIVE: a booking/hold status or availability.
 * Such prose was true when it passed grounding, not necessarily now, so it is never replayed as
 * stored (ADR 0017 §14): the server re-reads the current state or replaces it with a neutral line.
 */
export function timeSensitiveClaims(reply: string): { booking: boolean; availability: boolean } {
  const text = blankFillers(reply.replace(/[‘’]/g, "'"));
  return {
    booking:
      BOOKING_STATUS_MENTION.test(text) ||
      new RegExp(BOOKED_CLAIM.source, "i").test(text) ||
      new RegExp(HOLD_CLAIM.source, "i").test(text),
    availability:
      AVAILABILITY_MENTION.test(text) || new RegExp(AVAILABLE_CLAIM.source, "i").test(text),
  };
}

// ── server-written facts (used when the model's prose cannot be trusted) ─────

export function factSentences(
  evidence: Evidence[],
  formatMoney: (cents: number) => string,
): string[] {
  const out: string[] = [];
  for (const e of evidence) {
    switch (e.kind) {
      case "availability":
        out.push(
          e.result === "available"
            ? `${e.productName} (quantity ${String(e.quantity)}) shows as available for the time you asked about. It is not reserved until a booking is requested.`
            : e.result === "unavailable"
              ? `${e.productName} (quantity ${String(e.quantity)}) is not available for the time you asked about.`
              : `The team needs to confirm ${e.productName} for the time you asked about.`,
        );
        break;
      case "price": {
        const total = e.amounts.find((a) => a.role === "total");
        out.push(
          e.status === "priced" && total
            ? `The calculated total for those details is ${formatMoney(total.cents)} (see the price breakdown).`
            : "I need the team to review that before I can give you a confirmed price.",
        );
        break;
      }
      case "service_area":
        out.push(
          e.status === "serviceable"
            ? e.feeCents !== null
              ? `Delivery to that address is available; the delivery charge is ${formatMoney(e.feeCents)}.`
              : "Delivery to that address is available."
            : e.status === "outside_service_area"
              ? "That address is outside the delivery area; the team can review special requests."
              : "The team needs to review delivery to that address.",
        );
        break;
      case "quote": {
        const total = e.amounts.find((a) => a.role === "total");
        out.push(
          e.priceIsFinal && total
            ? `Quote ${e.quoteNumber} is ready with a total of ${formatMoney(total.cents)}.`
            : `Quote ${e.quoteNumber} is ready; the price needs the team's review before it is final.`,
        );
        break;
      }
      case "booking":
        out.push(e.message);
        break;
      case "catalog_price":
        break;
    }
  }
  return out;
}
