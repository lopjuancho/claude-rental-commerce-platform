/**
 * Money is integer minor units (cents) everywhere. Parsing is strict: anything ambiguous is
 * rejected rather than guessed.
 */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = "0", fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Integer division rounding half away from zero (money rounding). Inputs must be integers. */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("divideRoundHalfUp expects safe integers and a positive denominator");
  }
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const quotient = Math.floor(abs / denominator);
  const remainder = abs - quotient * denominator;
  return sign * (remainder * 2 >= denominator ? quotient + 1 : quotient);
}

/** amount × bps / 10 000, rounded half-up to the cent (bps: 2500 = 25 %). */
export function percentOf(amountCents: number, basisPoints: number): number {
  return divideRoundHalfUp(amountCents * basisPoints, 10_000);
}
