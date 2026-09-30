/**
 * Reads every row of a range-paginated query (ADR 0016 §12).
 *
 * The API caps each response (PostgREST `max_rows`, 1000 on Supabase), and a short page does not
 * prove the end when the cap is below the requested page size. So pages are requested until an
 * EMPTY page comes back, and the next page always starts after the rows actually received. The
 * query must order by a unique key so pages are deterministic.
 */
export async function collectPages<T>(
  page: (from: number, to: number) => PromiseLike<T[]>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? 1000;
  const maxRows = options.maxRows ?? 200_000;
  const rows: T[] = [];
  for (;;) {
    const batch = await page(rows.length, rows.length + pageSize - 1);
    if (batch.length === 0) return rows;
    rows.push(...batch);
    if (rows.length > maxRows) throw new Error(`Result exceeds ${String(maxRows)} rows`);
  }
}
