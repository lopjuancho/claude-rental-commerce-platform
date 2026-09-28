import "server-only";
import { parseMoneyToCents } from "@/domain/money";

/**
 * FormData → plain values for Zod. Blank inputs become null ("not set" / inherit); parsing
 * failures become NaN so the schema reports them against the right field.
 */
export class FormReader {
  constructor(private readonly fd: FormData) {}

  text(name: string): string | null {
    const v = this.fd.get(name);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  }
  int(name: string): number | null {
    const v = this.text(name);
    return v === null ? null : /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
  }
  decimal(name: string): number | null {
    const v = this.text(name);
    return v === null ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
  }
  cents(name: string): number | null {
    const v = this.text(name);
    return v === null ? null : (parseMoneyToCents(v) ?? Number.NaN);
  }
  /** Hours input stored as minutes. */
  hoursAsMinutes(name: string): number | null {
    const h = this.decimal(name);
    return h === null || Number.isNaN(h) ? h : Math.round(h * 60);
  }
  checkbox(name: string): boolean {
    return this.fd.get(name) === "on";
  }
  triState(name: string): boolean | null {
    const v = this.fd.get(name);
    return v === "yes" ? true : v === "no" ? false : null;
  }
  all(name: string): string[] {
    return this.fd.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");
  }
  list(name: string): string[] {
    return (this.text(name) ?? "")
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
