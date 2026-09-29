import type { Metadata } from "next";
import { requireStaff } from "@/server/auth/context";
import { getOrganizationTimezone, listVariantOptions } from "@/server/availability/service";
import { PricingNav } from "../pricing-nav";
import { CalculatorForm } from "./calculator-form";

export const metadata: Metadata = { title: "Price calculator" };

export default async function CalculatorPage() {
  const ctx = await requireStaff("org.read");
  const [options, timeZone] = await Promise.all([listVariantOptions(), getOrganizationTimezone()]);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Pricing</h1>
      <PricingNav current="calculator" />
      <p className="text-sm text-muted-foreground">
        Runs the same engine the storefront and assistant use. Times are in {timeZone}. Use it to
        review prices before quoting.
      </p>
      <CalculatorForm
        options={options.map((o) => ({ variantId: o.variantId, label: o.label }))}
        canSave={ctx.permissions.has("quotes.write")}
      />
    </div>
  );
}
