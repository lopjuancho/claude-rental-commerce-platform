import { describe, expect, it } from "vitest";
import {
  toBoolean,
  toCents,
  toDecimal,
  toDimensions,
  toInteger,
  toList,
} from "@/domain/import/transforms";
import { formatCents, parseMoneyToCents } from "@/domain/money";

describe("money", () => {
  it.each([
    ["175", 17500],
    ["$175.00", 17500],
    ["1,250.5", 125050],
    ["0.99", 99],
  ])("%s → %i cents", (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents);
  });
  it.each(["", "abc", "1.999", "-5", "12.3.4", "€10"])("rejects %j", (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });
  it("formats cents", () => {
    expect(formatCents(45000)).toBe("$450.00");
  });
});

describe("cell transforms", () => {
  it("booleans", () => {
    expect([
      toBoolean("Yes"),
      toBoolean("n"),
      toBoolean("x"),
      toBoolean(""),
      toBoolean(undefined),
    ]).toEqual([true, false, true, null, null]);
    expect(() => toBoolean("maybe")).toThrow(/yes\/no/);
  });
  it("numbers", () => {
    expect(toInteger("1,200")).toBe(1200);
    expect(() => toInteger("1.5")).toThrow();
    expect(toDecimal("15 ft")).toBe(15);
    expect(toDecimal("15'")).toBe(15);
    expect(() => toDecimal("fifteen")).toThrow();
    expect(toCents("$1.50")).toBe(150);
    expect(() => toCents("free")).toThrow(/price/);
  });
  it("lists", () => {
    expect(toList("a; b | c, d ;;")).toEqual(["a", "b", "c", "d"]);
  });
  it("dimensions", () => {
    expect(toDimensions("15x15x14")).toEqual({ length: 15, width: 15, height: 14 });
    expect(toDimensions("32' x 15' x 18'")).toEqual({ length: 32, width: 15, height: 18 });
    expect(toDimensions("20 X 20")).toEqual({ length: 20, width: 20, height: null });
    expect(() => toDimensions("big")).toThrow();
    expect(() => toDimensions("0x5")).toThrow();
  });
});
