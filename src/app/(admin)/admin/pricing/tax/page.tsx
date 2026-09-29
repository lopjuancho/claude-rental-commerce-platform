import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaff } from "@/server/auth/context";
import { listTaxJurisdictions } from "@/server/pricing/config";
import { deleteTaxAction } from "../actions";
import { PricingNav } from "../pricing-nav";
import { TaxForm } from "./tax-form";

export const metadata: Metadata = { title: "Tax" };

export default async function TaxPage() {
  const ctx = await requireStaff("org.read");
  const canWrite = ctx.permissions.has("pricing.write");
  const jurisdictions = await listTaxJurisdictions();
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Pricing</h1>
      <PricingNav current="tax" />
      <p className="text-sm text-muted-foreground">
        Tax is determined from the event address (state + ZIP). Nothing is assumed: an address
        without a matching jurisdiction, a component without a taxable setting, or a jurisdiction
        still in test status makes the price require manual review. Enter only verified production
        rules as Active.
      </p>
      {jurisdictions.length === 0 ? (
        <p className="text-sm">
          No tax jurisdictions configured yet: every price will require tax review.
        </p>
      ) : null}
      {jurisdictions.map((j) => (
        <details key={j.id} className="rounded-xl border bg-card">
          <summary className="cursor-pointer px-4 py-3 text-sm">
            <span className="font-medium">{j.name}</span> · {j.state}{" "}
            {j.postal_codes.length ? `(${j.postal_codes.length} ZIPs)` : "(statewide)"} ·{" "}
            {j.tax_rates.reduce((s, r) => s + r.rate_bps, 0) / 100}% ·{" "}
            <span className={j.status === "test" ? "font-medium text-amber-600" : ""}>
              {j.status}
            </span>{" "}
            · rev {j.revision}
          </summary>
          {canWrite ? (
            <div className="grid gap-3 border-t p-4">
              <TaxForm
                values={{
                  id: j.id,
                  name: j.name,
                  state: j.state,
                  postalCodes: j.postal_codes,
                  reviewPostalCodes: j.requires_review_postal_codes,
                  status: j.status,
                  priority: j.priority,
                  rates: j.tax_rates,
                  taxability: Object.fromEntries(
                    j.tax_component_rules.map((r) => [r.component, r.taxable]),
                  ),
                }}
              />
              <form action={deleteTaxAction}>
                <input type="hidden" name="id" value={j.id} />
                <Button size="sm" variant="outline" type="submit">
                  Delete jurisdiction
                </Button>
              </form>
            </div>
          ) : null}
        </details>
      ))}
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a tax jurisdiction</CardTitle>
          </CardHeader>
          <CardContent>
            <TaxForm />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
