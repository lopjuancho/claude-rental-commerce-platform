import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPeriod, parseTstzRange } from "@/lib/ranges";
import { requireStaff } from "@/server/auth/context";
import {
  getOrganizationTimezone,
  listBlocks,
  listVariantOptions,
} from "@/server/availability/service";
import { deleteBlockAction } from "../actions";
import { BlockForm, type BlockTarget } from "./block-form";

export const metadata: Metadata = { title: "Availability blocks" };

export default async function BlocksPage() {
  const ctx = await requireStaff("org.read");
  const canWrite = ctx.permissions.has("availability.write");
  const [blocks, options, timeZone] = await Promise.all([
    listBlocks(),
    listVariantOptions(),
    getOrganizationTimezone(),
  ]);

  const products = new Map(options.map((o) => [o.productId, o.label.split(" — ")[0] ?? o.label]));
  const targets: BlockTarget[] = [
    { value: "organization", label: "Everything (blackout)" },
    ...[...products.entries()].map(([id, name]) => ({
      value: `product:${id}`,
      label: `${name} (all units)`,
    })),
    ...options.flatMap((o) =>
      o.trackingMode === "pooled"
        ? [
            {
              value: `variant:${o.variantId}`,
              label: `${o.label} (some of the quantity)`,
              pooled: true,
            },
          ]
        : o.units.map((u) => ({ value: `unit:${u.id}`, label: `${o.label} · ${u.label}` })),
    ),
  ];

  return (
    <div className="grid gap-6">
      <div>
        <Link href="/admin/availability" className="text-sm text-muted-foreground hover:underline">
          ← Availability
        </Link>
        <h1 className="text-2xl font-semibold">Blocks</h1>
        <p className="text-sm text-muted-foreground">
          Blocks stop new bookings. Existing bookings that overlap are flagged for review, never
          cancelled.
        </p>
      </div>
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a block</CardTitle>
          </CardHeader>
          <CardContent>
            <BlockForm targets={targets} />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Current and upcoming</CardTitle>
        </CardHeader>
        <CardContent>
          {blocks.length === 0 ? <p className="text-sm text-muted-foreground">No blocks.</p> : null}
          <ul className="divide-y text-sm">
            {blocks.map((b) => {
              const range = parseTstzRange(b.period);
              const what =
                b.inventory_units?.label ??
                b.products?.name ??
                (b.variant_id ? `${b.quantity ?? "All"} of a pooled item` : "Everything");
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="flex-1">
                    <span className="font-medium">{what}</span> ·{" "}
                    {range ? formatPeriod(range, timeZone) : ""} ·{" "}
                    <span className="capitalize">{b.reason.replace("_", " ")}</span>
                    {b.notes ? ` · ${b.notes}` : ""}
                  </span>
                  {canWrite ? (
                    <form action={deleteBlockAction}>
                      <input type="hidden" name="blockId" value={b.id} />
                      <Button size="sm" variant="ghost" type="submit">
                        Remove
                      </Button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
