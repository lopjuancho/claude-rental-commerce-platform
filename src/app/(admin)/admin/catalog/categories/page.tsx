import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaff } from "@/server/auth/context";
import { listCategories } from "@/server/catalog/categories";
import { listCategoryHazardRules } from "@/server/catalog/weather-rules";
import { archiveCategoryAction } from "./actions";
import { CategoryForm } from "./category-form";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesPage() {
  const ctx = await requireStaff("org.read");
  const canWrite = ctx.permissions.has("catalog.write");
  const [categories, rules] = await Promise.all([listCategories(), listCategoryHazardRules()]);
  const parents = categories.map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Categories</h1>
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>New category</CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryForm parents={parents} />
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-3">
        {categories.length === 0 ? (
          <p className="text-muted-foreground">No categories yet.</p>
        ) : null}
        {categories.map((c) => (
          <details key={c.id} className="rounded-xl border bg-card">
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
              <span className="font-medium">{c.name}</span>
              <span className="text-xs text-muted-foreground">
                {c.is_published ? "Published" : "Hidden"}
                {(rules.get(c.id) ?? [])
                  .filter((r) => r.sensitive)
                  .map(
                    (r) =>
                      ` · ${r.hazard.replace("_", " ")}${r.threshold_value ? ` ${r.threshold_value} ${r.threshold_unit ?? ""}` : ""}`,
                  )
                  .join("")}
                {c.included_duration_minutes ? ` · ${c.included_duration_minutes / 60} h` : ""}
              </span>
            </summary>
            {canWrite ? (
              <div className="grid gap-4 border-t p-4">
                <CategoryForm
                  parents={parents}
                  values={{
                    id: c.id,
                    name: c.name,
                    slug: c.slug,
                    parentId: c.parent_id,
                    sortOrder: c.sort_order,
                    isPublished: c.is_published,
                    setupBufferMinutes: c.setup_buffer_minutes,
                    teardownBufferMinutes: c.teardown_buffer_minutes,
                    includedDurationMinutes: c.included_duration_minutes,
                    overnightAllowed: c.overnight_allowed,
                    weatherRules: rules.get(c.id) ?? [],
                  }}
                />
                <form action={archiveCategoryAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <Button type="submit" variant="outline" size="sm">
                    Archive category
                  </Button>
                </form>
              </div>
            ) : null}
          </details>
        ))}
      </div>
    </div>
  );
}
