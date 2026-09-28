import { uniqueSlug } from "@/domain/catalog/slug";
import type { RowIssue, ValidatedRow } from "./validate";

export type RowAction = "create" | "update" | "skip";

export interface PlannedRow extends ValidatedRow {
  action: RowAction;
}

export interface ExistingCatalog {
  /** slug → external_ref (null when the product was not imported from this source). */
  slugs: ReadonlyMap<string, string | null>;
  /** external_refs already imported from this source. */
  externalRefs: ReadonlySet<string>;
}

export interface ImportPlanSummary {
  create: number;
  update: number;
  skip: number;
  errors: number;
}

/**
 * Decides create/update/skip per row. Matching: source external_ref first, then slug (only when
 * the row has no external_ref). Duplicates inside the file are rejected rather than merged.
 */
export function planImport(
  rows: readonly ValidatedRow[],
  existing: ExistingCatalog,
): { rows: PlannedRow[]; summary: ImportPlanSummary } {
  const takenSlugs = new Set(existing.slugs.keys());
  const seenRefs = new Set<string>();
  const seenSlugs = new Set<string>();
  const planned: PlannedRow[] = [];

  for (const row of rows) {
    if (!row.mapped || row.errors.length > 0) {
      planned.push({ ...row, action: "skip" });
      continue;
    }
    const mapped = { ...row.mapped };
    const errors: RowIssue[] = [];
    const warnings: RowIssue[] = [...row.warnings];
    let action: RowAction;

    if (mapped.external_ref) {
      if (seenRefs.has(mapped.external_ref)) {
        errors.push({
          field: "external_ref",
          message: `Source ID "${mapped.external_ref}" appears more than once in this file.`,
        });
      }
      seenRefs.add(mapped.external_ref);
      if (existing.externalRefs.has(mapped.external_ref)) {
        action = "update";
      } else {
        action = "create";
        const slug = uniqueSlug(mapped.slug, new Set([...takenSlugs, ...seenSlugs]));
        if (slug !== mapped.slug) {
          warnings.push({
            field: "slug",
            message: `URL slug "${mapped.slug}" is taken; using "${slug}".`,
          });
          mapped.slug = slug;
        }
      }
    } else {
      if (seenSlugs.has(mapped.slug)) {
        errors.push({
          field: "name",
          message: `"${mapped.name}" appears more than once in this file.`,
        });
      }
      action = existing.slugs.has(mapped.slug) ? "update" : "create";
      if (action === "update")
        warnings.push({ field: "row", message: `Updates the existing product "${mapped.slug}".` });
    }
    seenSlugs.add(mapped.slug);

    if (errors.length > 0)
      planned.push({
        ...row,
        mapped: null,
        errors: [...row.errors, ...errors],
        warnings,
        action: "skip",
      });
    else planned.push({ ...row, mapped, warnings, action });
  }

  const summary: ImportPlanSummary = { create: 0, update: 0, skip: 0, errors: 0 };
  for (const r of planned) {
    summary[r.action]++;
    if (r.errors.length > 0) summary.errors++;
  }
  return { rows: planned, summary };
}
