import { z } from "zod";

/** US postal address as used for delivery routing and tax jurisdiction (Phase 1: US only). */
export const postalAddressSchema = z.object({
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(2).max(120),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Use the two-letter state code."),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Use a 5-digit ZIP code."),
});
export type PostalAddress = z.infer<typeof postalAddressSchema>;

/** One-line form sent to routing providers. */
export function formatAddress(a: PostalAddress): string {
  return [a.line1, a.line2, a.city, `${a.state} ${a.postalCode}`]
    .filter((p) => p && p.trim() !== "")
    .join(", ");
}

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bstreet\b/g, "st"],
  [/\bavenue\b/g, "ave"],
  [/\broad\b/g, "rd"],
  [/\bdrive\b/g, "dr"],
  [/\blane\b/g, "ln"],
  [/\bboulevard\b/g, "blvd"],
  [/\bcourt\b/g, "ct"],
  [/\bplace\b/g, "pl"],
  [/\bparkway\b/g, "pkwy"],
  [/\bnorth\b/g, "n"],
  [/\bsouth\b/g, "s"],
  [/\beast\b/g, "e"],
  [/\bwest\b/g, "w"],
];

/**
 * Cache-key normalization: case, punctuation, whitespace and common street-suffix spellings.
 * Deliberately conservative — two addresses only share a cache entry when they are the same text
 * after normalization; nothing is geocoded or guessed here.
 */
export function normalizeAddress(a: PostalAddress): string {
  let s = formatAddress({ ...a, postalCode: a.postalCode.slice(0, 5) }).toLowerCase();
  s = s.replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, abbr] of ABBREVIATIONS) s = s.replace(re, abbr);
  return s;
}
