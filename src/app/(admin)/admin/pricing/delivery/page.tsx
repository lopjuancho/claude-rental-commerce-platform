import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/domain/money";
import { requireStaff } from "@/server/auth/context";
import { getServerEnv } from "@/server/env";
import { getDeliverySettings, listServiceAreas } from "@/server/pricing/config";
import { deleteAreaAction } from "../actions";
import { PricingNav } from "../pricing-nav";
import { DeliverySettingsForm, ServiceAreaForm } from "./delivery-forms";

export const metadata: Metadata = { title: "Delivery pricing" };

export default async function DeliveryPage() {
  const ctx = await requireStaff("org.read");
  const canWrite = ctx.permissions.has("pricing.write");
  const [s, areas] = await Promise.all([getDeliverySettings(), listServiceAreas()]);
  const providerConfigured = Boolean(getServerEnv().GOOGLE_MAPS_API_KEY);

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Pricing</h1>
      <PricingNav current="delivery" />
      <p className="text-sm text-muted-foreground">
        Delivery is priced from the road distance (Google Maps) between the depot and the event. If
        the distance can&apos;t be determined, the address is outside your areas, or it is beyond
        the maximum, the delivery is marked for manual review; a fee is never estimated.
        {providerConfigured
          ? ""
          : " The Google Maps key is not configured in this environment, so mileage deliveries currently need manual review."}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Depot and mileage</CardTitle>
        </CardHeader>
        <CardContent>
          <DeliverySettingsForm
            disabled={!canWrite}
            values={{
              depotLine1: s.primary_depot_address_line1,
              depotCity: s.primary_depot_city,
              depotState: s.primary_depot_state,
              depotPostalCode: s.primary_depot_postal_code,
              freeMiles: s.free_delivery_miles,
              perMileRateCents: s.per_mile_rate_cents,
              maximumMiles: s.maximum_delivery_miles,
              rounding: s.mileage_rounding_method,
              basis: s.mileage_basis,
            }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Service areas</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            {areas.length === 0
              ? "No service areas: mileage pricing applies to any address the map can route to. Add areas to limit where you deliver."
              : "Addresses must match an area; anything else is marked for manual review. ZIP matches take precedence over city matches."}
          </p>
          {areas.map((a) => (
            <details key={a.id} className="rounded-md border">
              <summary className="cursor-pointer px-3 py-2 text-sm">
                <span className="font-medium">{a.name}</span> ·{" "}
                {a.pricing === "flat"
                  ? `flat ${formatCents(a.flat_fee_cents ?? 0)}`
                  : a.pricing === "mileage"
                    ? "mileage"
                    : "staff quote"}{" "}
                · {a.service_area_rules.length} rule(s){a.is_active ? "" : " · inactive"}
              </summary>
              {canWrite ? (
                <div className="grid gap-3 border-t p-3">
                  <ServiceAreaForm
                    values={{
                      id: a.id,
                      name: a.name,
                      pricing: a.pricing,
                      flatFeeCents: a.flat_fee_cents,
                      priority: a.priority,
                      active: a.is_active,
                      postalCodes: a.service_area_rules.flatMap((r) =>
                        r.postal_code ? [r.postal_code] : [],
                      ),
                      cities: a.service_area_rules.flatMap((r) =>
                        r.city ? [`${r.city}, ${r.state ?? ""}`] : [],
                      ),
                    }}
                  />
                  <form action={deleteAreaAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <Button size="sm" variant="outline" type="submit">
                      Delete area
                    </Button>
                  </form>
                </div>
              ) : null}
            </details>
          ))}
          {canWrite ? (
            <div className="rounded-md border border-dashed p-3">
              <p className="mb-3 text-sm font-medium">Add a service area</p>
              <ServiceAreaForm />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
