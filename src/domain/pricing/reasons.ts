/** Human-readable explanations for engine review reasons ("CODE" or "CODE:detail"). */
export const REVIEW_REASON_TEXT: Record<string, string> = {
  NO_ITEMS: "No items to price.",
  INVALID_ITEM: "An item has an invalid quantity or time period.",
  ITEM_UNAVAILABLE: "An item is inactive or archived.",
  EXTRA_HOURS_PRICING_NOT_CONFIGURED:
    "The rental is longer than the included duration and no extra-time rate is configured.",
  OVERNIGHT_PRICING_NOT_CONFIGURED:
    "The rental runs overnight and no overnight charge is configured.",
  OVERNIGHT_NOT_PERMITTED: "The rental runs overnight, which is not permitted for this item.",
  ADDITIONAL_DAY_PRICING_NOT_CONFIGURED:
    "The rental spans several days and no additional-day rule is configured.",
  ATTENDANT_PRICING_NOT_CONFIGURED:
    "The item requires attendants and no attendant rate is configured.",
  RULE_INVALID: "A pricing rule has invalid settings.",
  INVALID_ADJUSTMENT: "A manual adjustment is invalid.",
  DELIVERY: "Delivery could not be priced automatically",
  TAX_JURISDICTION_UNRESOLVED: "No tax jurisdiction is configured for this location.",
  TAX_TEST_CONFIGURATION: "Tax was calculated with TEST rates, not verified production rules.",
  TAX_BOUNDARY_REVIEW: "This ZIP code straddles a tax boundary.",
  TAX_RATES_NOT_CONFIGURED: "The tax jurisdiction has no rates.",
  TAX_TAXABILITY_NOT_CONFIGURED: "Taxability is not configured for a charge type",
};

export const DELIVERY_REASON_TEXT: Record<string, string> = {
  PROVIDER_ERROR: "the map service did not answer",
  ADDRESS_NOT_FOUND: "the address could not be found",
  AMBIGUOUS_ADDRESS: "the address matched only partially",
  NO_ROUTE: "no driving route was found",
  OUTSIDE_SERVICE_AREA: "the address is outside the delivery areas",
  SERVICE_AREA_REQUIRES_REVIEW: "this area is quoted by staff",
  OUTSIDE_MAX_DISTANCE: "the address is beyond the maximum delivery distance",
  MILEAGE_NOT_CONFIGURED: "mileage pricing is not configured",
  DEPOT_NOT_CONFIGURED: "the depot address is not configured",
  DISTANCE_PROVIDER_NOT_CONFIGURED: "the map service is not configured",
};

export function explainReviewReason(reason: string): string {
  const [code = "", detail] = reason.split(":");
  const base = REVIEW_REASON_TEXT[code] ?? code;
  if (code === "DELIVERY" && detail) return `${base}: ${DELIVERY_REASON_TEXT[detail] ?? detail}.`;
  if (code === "TAX_TAXABILITY_NOT_CONFIGURED" && detail)
    return `${base} (${detail.replace("_", " ")}).`;
  return base;
}
