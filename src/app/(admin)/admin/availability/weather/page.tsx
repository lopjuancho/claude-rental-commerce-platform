import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HAZARD_LABELS } from "@/domain/weather/hazards";
import { formatPeriod, parseTstzRange } from "@/lib/ranges";
import { requireStaff } from "@/server/auth/context";
import {
  getOrganizationTimezone,
  listVariantOptions,
  listWeatherBlocks,
} from "@/server/availability/service";
import { listCategories } from "@/server/catalog/categories";
import { weatherBlockAction } from "../actions";
import { WeatherForm } from "./weather-form";

export const metadata: Metadata = { title: "Weather blocks" };

const STATUS_STYLE: Record<string, string> = {
  proposed: "border-dashed",
  confirmed: "border-destructive/50 bg-destructive/5",
  lifted: "opacity-60",
};

export default async function WeatherPage() {
  const ctx = await requireStaff("org.read");
  const canWrite = ctx.permissions.has("availability.write");
  const [blocks, categories, options, timeZone] = await Promise.all([
    listWeatherBlocks(),
    listCategories(),
    listVariantOptions(),
    getOrganizationTimezone(),
  ]);
  const products = [
    ...new Map(options.map((o) => [o.productId, o.label.split(" — ")[0] ?? o.label])).entries(),
  ].map(([id, name]) => ({ id, name }));

  return (
    <div className="grid gap-6">
      <div>
        <Link href="/admin/availability" className="text-sm text-muted-foreground hover:underline">
          ← Availability
        </Link>
        <h1 className="text-2xl font-semibold">Weather blocks</h1>
        <p className="text-sm text-muted-foreground">
          A proposed block only warns. Once a staff member confirms it, affected items can&apos;t be
          booked and overlapping bookings are flagged for review. Nothing is cancelled
          automatically.
        </p>
      </div>
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Propose a weather block</CardTitle>
          </CardHeader>
          <CardContent>
            <WeatherForm
              categories={categories.map((c) => ({ id: c.id, name: c.name }))}
              products={products}
            />
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-3">
        {blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent weather blocks.</p>
        ) : null}
        {blocks.map((w) => {
          const range = parseTstzRange(w.period);
          const targets = w.weather_block_targets
            .map((t) => t.categories?.name ?? t.products?.name)
            .filter(Boolean);
          return (
            <div
              key={w.id}
              className={`grid gap-2 rounded-xl border p-4 text-sm ${STATUS_STYLE[w.status] ?? ""}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{HAZARD_LABELS[w.hazard]}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
                  {w.status}
                </span>
                <span className="text-muted-foreground">
                  {range ? formatPeriod(range, timeZone) : ""}
                </span>
              </div>
              <p>
                {w.reason}
                {w.observed_value != null
                  ? ` · observed ${w.observed_value} ${w.observed_unit ?? ""}`
                  : ""}
                {w.scope === "selected"
                  ? ` · only: ${targets.join(", ")}`
                  : " · all sensitive items"}
              </p>
              {canWrite && w.status !== "lifted" ? (
                <form action={weatherBlockAction} className="flex gap-1">
                  <input type="hidden" name="weatherBlockId" value={w.id} />
                  {w.status === "proposed" ? (
                    <>
                      <Button size="sm" type="submit" name="intent" value="confirm">
                        Confirm block
                      </Button>
                      <Button size="sm" variant="ghost" type="submit" name="intent" value="delete">
                        Discard
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" type="submit" name="intent" value="lift">
                      Lift block
                    </Button>
                  )}
                </form>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
