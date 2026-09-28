import { parseMoneyToCents } from "@/domain/money";

/** Value parsers for source cells. Each returns null for blank, or throws a user-facing message. */
export class CellError extends Error {}

const TRUE = new Set(["y", "yes", "true", "t", "1", "x", "✓", "on"]);
const FALSE = new Set(["n", "no", "false", "f", "0", "off", "-"]);

export function blank(value: string | undefined): value is undefined | "" {
  return value === undefined || value.trim() === "";
}

export function toBoolean(value: string | undefined): boolean | null {
  if (blank(value)) return null;
  const v = value.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  throw new CellError(`"${value}" is not yes/no.`);
}

export function toInteger(value: string | undefined): number | null {
  if (blank(value)) return null;
  const v = value.trim().replace(/,/g, "");
  if (!/^-?\d+$/.test(v)) throw new CellError(`"${value}" is not a whole number.`);
  return Number(v);
}

export function toDecimal(value: string | undefined): number | null {
  if (blank(value)) return null;
  const v = value
    .trim()
    .replace(/,/g, "")
    .replace(/\s*(ft|feet|')$/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new CellError(`"${value}" is not a number.`);
  return Number(v);
}

export function toCents(value: string | undefined): number | null {
  if (blank(value)) return null;
  const cents = parseMoneyToCents(value);
  if (cents === null) throw new CellError(`"${value}" is not a price.`);
  return cents;
}

export function toList(value: string | undefined): string[] | null {
  if (blank(value)) return null;
  return value
    .split(/[;|,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** "15x20x16", "15' x 20' x 16'", "15 X 20" → feet. */
export function toDimensions(
  value: string | undefined,
): { length: number; width: number; height: number | null } | null {
  if (blank(value)) return null;
  const parts = value
    .toLowerCase()
    .replace(/feet|ft|'/g, "")
    .split(/\s*[x×]\s*/)
    .map((p) => p.trim());
  const nums = parts.map((p) => (/^\d+(\.\d+)?$/.test(p) ? Number(p) : NaN));
  const [length, width, height, ...rest] = nums;
  if (
    length === undefined ||
    width === undefined ||
    rest.length > 0 ||
    nums.some((n) => Number.isNaN(n) || n <= 0)
  ) {
    throw new CellError(`"${value}" is not L x W (x H) in feet.`);
  }
  return { length, width, height: height ?? null };
}
