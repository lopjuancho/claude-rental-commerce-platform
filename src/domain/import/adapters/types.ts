import type { FieldMapping, ImportFieldKey } from "../fields";

/**
 * An import adapter describes how one source format maps onto the canonical import fields.
 * Adapters are data (header synonyms) — they never change the product model (ADR 0011).
 */
export interface ImportAdapter {
  id: string;
  label: string;
  /** Stored as products.external_source so re-imports from the same system update in place. */
  externalSource: string;
  /** False until the adapter has been checked against a real export from that system. */
  verified: boolean;
  headerSynonyms: Partial<Record<ImportFieldKey, readonly string[]>>;
}

export const normalizeHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function suggestMapping(adapter: ImportAdapter, headers: readonly string[]): FieldMapping {
  const byNormalized = new Map(headers.map((h) => [normalizeHeader(h), h]));
  const used = new Set<string>();
  const mapping: FieldMapping = {};
  for (const [field, synonyms] of Object.entries(adapter.headerSynonyms) as [
    ImportFieldKey,
    readonly string[],
  ][]) {
    for (const synonym of synonyms) {
      const header = byNormalized.get(normalizeHeader(synonym));
      if (header && !used.has(header)) {
        mapping[field] = header;
        used.add(header);
        break;
      }
    }
  }
  return mapping;
}

/** Number of canonical fields the adapter can map for these headers. */
export function scoreAdapter(adapter: ImportAdapter, headers: readonly string[]): number {
  return Object.keys(suggestMapping(adapter, headers)).length;
}
