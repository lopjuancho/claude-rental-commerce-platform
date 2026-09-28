import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IMPORT_ADAPTERS } from "@/domain/import/adapters";
import { listImportBatches } from "@/server/catalog/imports";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Import products" };

export default async function ImportPage() {
  const batches = await listImportBatches();
  return (
    <div className="grid gap-6">
      <div>
        <Link href="/admin/catalog" className="text-sm text-muted-foreground hover:underline">
          ← Catalog
        </Link>
        <h1 className="text-2xl font-semibold">Import products</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Upload a CSV</CardTitle>
        </CardHeader>
        <CardContent>
          <UploadForm adapters={IMPORT_ADAPTERS.map((a) => ({ id: a.id, label: a.label }))} />
        </CardContent>
      </Card>
      {batches.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent imports</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {batches.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/admin/catalog/import/${b.id}`}
                    className="flex items-center gap-3 py-2 text-sm hover:underline"
                  >
                    <span className="flex-1 truncate">{b.original_filename ?? "Untitled"}</span>
                    <span className="text-muted-foreground">{b.row_count} rows</span>
                    <span className="capitalize text-muted-foreground">{b.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
