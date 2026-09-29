import { describe, expect, it } from "vitest";
import { explainReviewReason } from "@/domain/pricing/reasons";

describe("review reason explanations", () => {
  it("explains coded reasons with details", () => {
    expect(explainReviewReason("DELIVERY:ADDRESS_NOT_FOUND")).toBe(
      "Delivery could not be priced automatically: the address could not be found.",
    );
    expect(explainReviewReason("OVERNIGHT_PRICING_NOT_CONFIGURED:L1")).toBe(
      "The rental runs overnight and no overnight charge is configured.",
    );
    expect(explainReviewReason("TAX_TAXABILITY_NOT_CONFIGURED:add_on")).toBe(
      "Taxability is not configured for a charge type (add on).",
    );
    expect(explainReviewReason("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
