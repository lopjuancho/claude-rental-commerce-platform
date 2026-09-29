import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/domain/money";
import { requireStaff } from "@/server/auth/context";
import { listVariantOptions } from "@/server/availability/service";
import { listCategories } from "@/server/catalog/categories";
import { listPricingRules } from "@/server/pricing/config";
import { deleteRuleAction } from "./actions";
import { PricingNav } from "./pricing-nav";
import { RULE_TYPE_LABELS, RuleForm } from "./rule-form";

export const metadata: Metadata = { title: "Pricing rules" };

function describe(params: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof params.amount_cents === "number") parts.push(formatCents(params.amount_cents));
  if (typeof params.percent_of_base_bps === "number")
    parts.push(`${params.percent_of_base_bps / 100}% of base`);
  if (typeof params.percent_bps === "number") parts.push(`${params.percent_bps / 100}%`);
  if (typeof params.increment_minutes === "number" && params.increment_minutes !== 60)
    parts.push(`per ${params.increment_minutes} min`);
  if (typeof params.per === "string") parts.push(`per ${params.per}`);
  if (typeof params.min_quantity === "number") parts.push(`min qty ${params.min_quantity}`);
  return parts.join(" · ");
}

export default async function PricingRulesPage() {
  const ctx = await requireStaff("org.read");
  const canWrite = ctx.permissions.has("pricing.write");
  const [rules, categories, options] = await Promise.all([
    listPricingRules(),
    listCategories(),
    listVariantOptions(),
  ]);
  const products = [
    ...new Map(options.map((o) => [o.productId, o.label.split(" — ")[0] ?? o.label])).entries(),
  ];
  const scopes = [
    { value: "organization", label: "Whole business" },
    ...categories.map((c) => ({ value: `category:${c.id}`, label: `Category: ${c.name}` })),
    ...products.map(([id, name]) => ({ value: `product:${id}`, label: `Product: ${name}` })),
  ];

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Pricing</h1>
      <PricingNav current="rules" />
      <p className="text-sm text-muted-foreground">
        Prices are calculated only from these rules and product base prices. When something needed
        is missing (for example an overnight charge that hasn&apos;t been set), the price is marked
        for manual review instead of guessed. Editing a rule never changes prices already quoted.
      </p>
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a rule</CardTitle>
          </CardHeader>
          <CardContent>
            <RuleForm scopes={scopes} />
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-3">
        {rules.length === 0 ? <p className="text-sm text-muted-foreground">No rules yet.</p> : null}
        {rules.map((r) => {
          const params = r.params as Record<string, unknown>;
          const scope = r.products?.name
            ? `Product: ${r.products.name}`
            : r.categories?.name
              ? `Category: ${r.categories.name}`
              : "Whole business";
          return (
            <details key={r.id} className="rounded-xl border bg-card">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 text-sm">
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground">
                  {RULE_TYPE_LABELS[r.rule_type]} · {describe(params)} · {scope}
                  {r.discount_code ? ` · code ${r.discount_code}` : ""}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {r.is_active ? "Active" : "Inactive"} · rev {r.revision}
                </span>
              </summary>
              {canWrite ? (
                <div className="grid gap-3 border-t p-4">
                  <RuleForm
                    scopes={scopes}
                    values={{
                      id: r.id,
                      name: r.name,
                      type: r.rule_type,
                      scope: r.product_id
                        ? `product:${r.product_id}`
                        : r.category_id
                          ? `category:${r.category_id}`
                          : "organization",
                      params,
                      priority: r.priority,
                      discountCode: r.discount_code,
                      validFrom: r.valid_from,
                      validTo: r.valid_to,
                      active: r.is_active,
                    }}
                  />
                  <form action={deleteRuleAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <Button type="submit" size="sm" variant="outline">
                      Delete rule
                    </Button>
                  </form>
                </div>
              ) : null}
            </details>
          );
        })}
      </div>
    </div>
  );
}
