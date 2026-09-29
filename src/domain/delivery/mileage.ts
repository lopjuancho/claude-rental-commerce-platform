import { divideRoundHalfUp } from "@/domain/money";

/**
 * Road-distance delivery fee (ADR 0009). Integer arithmetic on hundredths of a mile so floating
 * point never changes a bill.
 *
 *   distance (mi, 2 dp)  = round(meters / 1609.344)            one way
 *   round_trip basis     = distance × 2
 *   billable             = max(0, distance − free miles), then rounded per rounding method
 *   fee                  = billable × per-mile rate
 *
 * Example: 8.2 mi, 5 free, ceil, $4/mi → ceil(3.2) = 4 mi → $16.
 */
export const METERS_PER_MILE = 1609.344;

export interface MileageSettings {
  freeMiles: number;
  perMileRateCents: number;
  maximumMiles: number | null;
  rounding: "ceil_whole_mile" | "round_whole_mile" | "none";
  basis: "one_way" | "round_trip";
}

export type MileageResult =
  | {
      status: "priced";
      distanceMiles: number;
      chargedMiles: number;
      billableMiles: number;
      feeCents: number;
    }
  | { status: "manual_review"; reason: "OUTSIDE_MAX_DISTANCE"; distanceMiles: number };

export const metersToHundredthsOfMile = (meters: number): number =>
  Math.round((meters * 100) / METERS_PER_MILE);

export function mileageFee(oneWayMeters: number, s: MileageSettings): MileageResult {
  if (!Number.isFinite(oneWayMeters) || oneWayMeters < 0)
    throw new RangeError("Distance must be a non-negative number");
  const oneWay = metersToHundredthsOfMile(oneWayMeters);
  const distanceMiles = oneWay / 100;
  if (s.maximumMiles !== null && oneWay > Math.round(s.maximumMiles * 100)) {
    return { status: "manual_review", reason: "OUTSIDE_MAX_DISTANCE", distanceMiles };
  }
  const charged = s.basis === "round_trip" ? oneWay * 2 : oneWay;
  const over = Math.max(0, charged - Math.round(s.freeMiles * 100)); // hundredths
  let billableHundredths: number;
  switch (s.rounding) {
    case "ceil_whole_mile":
      billableHundredths = Math.ceil(over / 100) * 100;
      break;
    case "round_whole_mile":
      billableHundredths = divideRoundHalfUp(over, 100) * 100;
      break;
    case "none":
      billableHundredths = over;
      break;
  }
  return {
    status: "priced",
    distanceMiles,
    chargedMiles: charged / 100,
    billableMiles: billableHundredths / 100,
    feeCents: divideRoundHalfUp(billableHundredths * s.perMileRateCents, 100),
  };
}
