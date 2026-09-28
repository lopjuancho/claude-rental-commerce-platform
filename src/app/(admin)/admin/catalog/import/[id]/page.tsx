import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isDomainError } from "@/domain/errors";
import { getAdapter } from "@/domain/import/adapters";
import { IMPORT_FIELD_KEYS, IMPORT_FIELDS } from "@/domain/import/fields";
import { getImportBatch, listImportRows } from "@/server/catalog/imports";
import { CommitForm, MappingForm, PresetForm } from "./import-forms";

export const metadata: Metadata = { title: "Review import" };

interface Issue {
  field: string;
  message: string;
}

export default async function ImportBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let batch;
  try {
    batch = await getImportBatch(id);
  } catch (e) {
    if (isDomainError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const rows = await listImportRows(id);
  const adapter = getAdapter(batch.adapter_id);
  const committed = batch.status === "committed";
  const validated = batch.status === "validated" || committed;
  const writable = rows.filter((r) => r.action === "create" || r.action === "update").length;

  return (
    <div className="grid gap-6">
      <div>
        <Link
          href="/admin/catalog/import"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Imports
        </Link>
        <h1 className="text-2xl font-semibold">{batch.original_filename ?? "Import"}</h1>
        <p className="text-sm text-muted-foreground">
          {batch.row_count} rows · {adapter?.label ?? batch.adapter_id} ·{" "}
          <span className="capitalize">{batch.status}</span>
        </p>
        {adapter && !adapter.verified ? (
          <p className="mt-2 rounded-md border border-dashed p-3 text-sm">
            The {adapter.label} mapping hasn&apos;t been checked against a real export yet. Review
            each field below before validating.
          </p>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Map columns to product fields</CardTitle>
        </CardHeader>
        <CardContent>
          <MappingForm
            batchId={batch.id}
            headers={batch.headers}
            disabled={committed}
            mapping={(batch.mapping ?? {}) as Record<string, string>}
            fields={IMPORT_FIELD_KEYS.map((k) => ({
              key: k,
              label: IMPORT_FIELDS[k].label,
              required: "required" in IMPORT_FIELDS[k],
            }))}
          />
        </CardContent>
      </Card>

      {validated ? (
        <Card>
          <CardHeader>
            <CardTitle>2. Review</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Row</th>
                    <th className="pr-3">Action</th>
                    <th className="pr-3">Product</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => {
                    const mapped = r.mapped as { name?: string; slug?: string } | null;
                    const errors = r.errors as unknown as Issue[];
                    const warnings = r.warnings as unknown as Issue[];
                    return (
                      <tr key={r.row_number} className="align-top">
                        <td className="py-2 pr-3 tabular-nums">{r.row_number}</td>
                        <td className="pr-3 capitalize">{r.action ?? "—"}</td>
                        <td className="pr-3">
                          {mapped?.name ?? <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="grid gap-1 py-2">
                          {errors.map((e) => (
                            <span key={`e-${e.field}-${e.message}`} className="text-destructive">
                              {e.message}
                            </span>
                          ))}
                          {warnings.map((w) => (
                            <span
                              key={`w-${w.field}-${w.message}`}
                              className="text-muted-foreground"
                            >
                              {w.message}
                            </span>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {batch.row_count > rows.length ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the first {rows.length} rows.
                </p>
              ) : null}
            </div>
            {!committed ? (
              <CommitForm batchId={batch.id} canCommit={writable > 0} />
            ) : (
              <p className="text-sm">
                Imported {batch.committed_at ? new Date(batch.committed_at).toLocaleString() : ""}.
              </p>
            )}
            <PresetForm batchId={batch.id} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
