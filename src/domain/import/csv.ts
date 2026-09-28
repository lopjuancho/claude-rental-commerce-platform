/**
 * RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines, CRLF, UTF-8 BOM).
 * Dependency-free and bounded so an oversized or malformed upload fails fast with a clear error.
 */
export interface CsvParseResult {
  headers: string[];
  rows: string[][];
  warnings: string[];
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 200,
};

export function parseCsv(text: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): CsvParseResult {
  if (new TextEncoder().encode(text).length > limits.maxBytes) {
    throw new CsvError(`File is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
  }
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const endRecord = () => {
    record.push(field);
    field = "";
    if (record.length > limits.maxColumns)
      throw new CsvError(`More than ${limits.maxColumns} columns.`);
    // Skip completely empty lines.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
    if (records.length > limits.maxRows + 1)
      throw new CsvError(`File has more than ${limits.maxRows} rows.`);
  };

  while (i < input.length) {
    const ch = input.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) throw new CsvError(`Unexpected quote in row ${records.length + 1}.`);
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      if (record.length > limits.maxColumns)
        throw new CsvError(`More than ${limits.maxColumns} columns.`);
    } else if (ch === "\r") {
      if (input[i + 1] === "\n") i++;
      endRecord();
    } else if (ch === "\n") {
      endRecord();
    } else {
      field += ch;
    }
    i++;
  }
  if (inQuotes) throw new CsvError("A quoted field is not closed.");
  if (field !== "" || record.length > 0) endRecord();

  const [rawHeaders, ...body] = records;
  if (!rawHeaders) throw new CsvError("The file is empty.");

  const warnings: string[] = [];
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((h, idx) => {
    let name = h.trim() || `Column ${idx + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) {
      warnings.push(`Duplicate column "${name}" renamed to "${name} (${count + 1})".`);
      name = `${name} (${count + 1})`;
    }
    return name;
  });

  const rows = body.map((r, idx) => {
    if (r.length !== headers.length) {
      warnings.push(`Row ${idx + 2} has ${r.length} cells; expected ${headers.length}.`);
    }
    return headers.map((_, c) => (r[c] ?? "").trim());
  });

  return { headers, rows, warnings };
}
