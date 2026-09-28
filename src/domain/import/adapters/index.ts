import { ersAdapter } from "./ers";
import { genericCsvAdapter } from "./generic-csv";
import { scoreAdapter, type ImportAdapter } from "./types";

export const IMPORT_ADAPTERS: readonly ImportAdapter[] = [genericCsvAdapter, ersAdapter];

export function getAdapter(id: string): ImportAdapter | undefined {
  return IMPORT_ADAPTERS.find((a) => a.id === id);
}

/** Best-matching adapter for a header row; falls back to the generic CSV adapter. */
export function detectAdapter(headers: readonly string[]): ImportAdapter {
  let best = genericCsvAdapter;
  let bestScore = scoreAdapter(genericCsvAdapter, headers);
  for (const adapter of IMPORT_ADAPTERS) {
    const score = scoreAdapter(adapter, headers);
    if (score > bestScore) {
      best = adapter;
      bestScore = score;
    }
  }
  return best;
}

export { suggestMapping, type ImportAdapter } from "./types";
