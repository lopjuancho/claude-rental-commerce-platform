import "server-only";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { detectAdapter, getAdapter, suggestMapping } from "@/domain/import/adapters";
import { CsvError, parseCsv } from "@/domain/import/csv";
import { IMPORT_FIELD_KEYS, type FieldMapping } from "@/domain/import/fields";
import { planImport } from "@/domain/import/plan";
import { missingRequiredFields, validateRow } from "@/domain/import/validate";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import type { Json } from "@/types/database";
import { fromDbError } from "./errors";

const CHUNK = 500;
/** Domain objects are plain JSON-serialisable data; this narrows them to the column type. */
const json = (value: unknown) => value as NonNullable<Json>;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Step 1 (ADR 0011): parse the CSV, pick an adapter, suggest a mapping, stage raw rows.
 * Nothing touches the catalog until commit.
 */
export async function stageImport(file: File, adapterId?: string): Promise<string> {
  const ctx = await requireStaff("catalog.write");
  if (file.size === 0 || file.size > MAX_IMPORT_BYTES)
    throw new DomainError("INVALID_INPUT", "CSV files must be under 5 MB.");

  let parsed;
  try {
    parsed = parseCsv(await file.text());
  } catch (e) {
    if (e instanceof CsvError) throw new DomainError("INVALID_INPUT", e.message);
    throw e;
  }
  if (parsed.rows.length === 0)
    throw new DomainError("INVALID_INPUT", "The file has a header row but no data.");

  const adapter = (adapterId ? getAdapter(adapterId) : undefined) ?? detectAdapter(parsed.headers);
  const db = await createUserClient();
  const batch = await db
    .from("import_batches")
    .insert({
      organization_id: ctx.organizationId,
      adapter_id: adapter.id,
      external_source: adapter.externalSource,
      original_filename: file.name.slice(0, 255),
      headers: parsed.headers,
      row_count: parsed.rows.length,
      mapping: json(suggestMapping(adapter, parsed.headers)),
      summary: { parse_warnings: parsed.warnings.slice(0, 50) },
      created_by: ctx.user.id,
    })
    .select("id")
    .single();
  if (batch.error) throw fromDbError(batch.error, "Import");

  const rows = parsed.rows.map((cells, i) => ({
    organization_id: ctx.organizationId,
    batch_id: batch.data.id,
    row_number: i + 2, // spreadsheet row number (header is row 1)
    raw: Object.fromEntries(parsed.headers.map((h, c) => [h, cells[c] ?? ""])),
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from("import_rows").insert(rows.slice(i, i + CHUNK));
    if (error) throw fromDbError(error, "Import");
  }
  return batch.data.id;
}

export async function getImportBatch(batchId: string) {
  const ctx = await requireStaff("catalog.write");
  const db = await createUserClient();
  const { data, error } = await db
    .from("import_batches")
    .select("*")
    .eq("id", batchId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (error) throw fromDbError(error, "Import");
  if (!data) throw new DomainError("NOT_FOUND", "Import not found.");
  return data;
}

export async function listImportRows(batchId: string, limit = 200) {
  const ctx = await requireStaff("catalog.write");
  const db = await createUserClient();
  const { data, error } = await db
    .from("import_rows")
    .select("row_number, raw, mapped, action, errors, warnings")
    .eq("batch_id", batchId)
    .eq("organization_id", ctx.organizationId)
    .order("row_number")
    .limit(limit);
  if (error) throw fromDbError(error, "Import");
  return data;
}

async function loadAllRows(batchId: string, organizationId: string) {
  const db = await createUserClient();
  const all: { id: string; row_number: number; raw: Json }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("import_rows")
      .select("id, row_number, raw")
      .eq("batch_id", batchId)
      .eq("organization_id", organizationId)
      .order("row_number")
      .range(from, from + 999);
    if (error) throw fromDbError(error, "Import");
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

async function loadExistingCatalog(organizationId: string, externalSource: string) {
  const db = await createUserClient();
  const slugs = new Map<string, string | null>();
  const externalRefs = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("products")
      .select("slug, external_source, external_ref")
      .eq("organization_id", organizationId)
      .range(from, from + 999);
    if (error) throw fromDbError(error, "Import");
    for (const p of data) {
      slugs.set(p.slug, p.external_source === externalSource ? p.external_ref : null);
      if (p.external_source === externalSource && p.external_ref) externalRefs.add(p.external_ref);
    }
    if (data.length < 1000) return { slugs, externalRefs };
  }
}

const mappingSchema = z.partialRecord(
  z.enum(IMPORT_FIELD_KEYS as [string, ...string[]]),
  z.string().min(1).max(200),
);

/**
 * Step 2: apply the (staff-reviewed) mapping, validate every row against the canonical schema
 * and plan create/update/skip. Can be re-run with a corrected mapping.
 */
export async function validateImport(batchId: string, rawMapping: unknown) {
  const ctx = await requireStaff("catalog.write");
  const batch = await getImportBatch(batchId);
  if (batch.status === "committed")
    throw new DomainError("CONFLICT", "This import was already committed.");

  const mapping = mappingSchema.parse(rawMapping) as FieldMapping;
  const unknownColumns = Object.values(mapping).filter((c) => !batch.headers.includes(c));
  if (unknownColumns.length > 0)
    throw new DomainError(
      "INVALID_INPUT",
      "The mapping refers to columns that are not in the file.",
    );
  const missing = missingRequiredFields(mapping);
  if (missing.length > 0)
    throw new DomainError("INVALID_INPUT", `Map these required fields: ${missing.join(", ")}.`);

  const stored = await loadAllRows(batchId, ctx.organizationId);
  const validated = stored.map((r) => {
    const raw = r.raw as Record<string, string>;
    return validateRow(
      batch.headers,
      batch.headers.map((h) => raw[h] ?? ""),
      mapping,
      r.row_number,
    );
  });
  const plan = planImport(
    validated,
    await loadExistingCatalog(ctx.organizationId, batch.external_source),
  );

  const db = await createUserClient();
  const storedByRow = new Map(stored.map((r) => [r.row_number, r]));
  const updates = plan.rows
    .flatMap((p) => {
      const source = storedByRow.get(p.rowNumber);
      return source ? [{ source, p }] : [];
    })
    .map(({ source, p }) => ({
      id: source.id,
      organization_id: ctx.organizationId,
      batch_id: batchId,
      row_number: p.rowNumber,
      raw: json(source.raw),
      mapped: p.mapped ? json(p.mapped) : null,
      action: p.action,
      errors: json(p.errors),
      warnings: json(p.warnings),
    }));
  for (let i = 0; i < updates.length; i += CHUNK) {
    const { error } = await db
      .from("import_rows")
      .upsert(updates.slice(i, i + CHUNK), { onConflict: "id" });
    if (error) throw fromDbError(error, "Import");
  }
  const { error } = await db
    .from("import_batches")
    .update({ mapping: json(mapping), status: "validated", summary: json({ plan: plan.summary }) })
    .eq("id", batchId)
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Import");
  return plan.summary;
}

/** Step 3: write the validated batch into the catalog in one database transaction. */
export async function commitImport(batchId: string) {
  await requireStaff("catalog.write");
  const db = await createUserClient();
  const { data, error } = await db.rpc("commit_product_import", { p_batch_id: batchId });
  if (error) throw fromDbError(error, "Import");
  return data as { created: number; updated: number; skipped: number };
}

export async function saveMappingPreset(batchId: string, name: string) {
  const ctx = await requireStaff("catalog.write");
  const batch = await getImportBatch(batchId);
  if (!batch.mapping) throw new DomainError("INVALID_INPUT", "Validate the mapping first.");
  const db = await createUserClient();
  const { error } = await db.from("import_mapping_presets").upsert(
    {
      organization_id: ctx.organizationId,
      adapter_id: batch.adapter_id,
      name: z.string().trim().min(1).max(120).parse(name),
      mapping: batch.mapping,
      created_by: ctx.user.id,
    },
    { onConflict: "organization_id,name" },
  );
  if (error) throw fromDbError(error, "Mapping preset");
}

export async function listImportBatches() {
  const ctx = await requireStaff("catalog.write");
  const db = await createUserClient();
  const { data, error } = await db
    .from("import_batches")
    .select(
      "id, original_filename, adapter_id, row_count, status, summary, created_at, committed_at",
    )
    .eq("organization_id", ctx.organizationId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw fromDbError(error, "Import");
  return data;
}
