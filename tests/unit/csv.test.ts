import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "@/domain/import/csv";

describe("parseCsv", () => {
  it("parses quoted fields, escaped quotes, embedded commas/newlines, CRLF and BOM", () => {
    const text = '﻿Name,Notes\r\n"Castle, Big","He said ""wow""\nsecond line"\r\nSlide,plain\r\n';
    expect(parseCsv(text)).toEqual({
      headers: ["Name", "Notes"],
      rows: [
        ["Castle, Big", 'He said "wow"\nsecond line'],
        ["Slide", "plain"],
      ],
      warnings: [],
    });
  });

  it("parses the generic spreadsheet fixture", () => {
    const { headers, rows } = parseCsv(
      readFileSync("tests/fixtures/imports/generic-spreadsheet.csv", "utf8"),
    );
    expect(headers[1]).toBe("Product Name");
    expect(rows).toHaveLength(3);
    expect(rows[1]![1]).toBe("Tropical Crush Combo, 2-lane");
  });

  it("skips blank lines, pads short rows and warns", () => {
    const { rows, warnings } = parseCsv("a,b,c\n\n1,2\n");
    expect(rows).toEqual([["1", "2", ""]]);
    expect(warnings[0]).toMatch(/Row 2 has 2 cells/);
  });

  it("renames duplicate and blank headers", () => {
    const { headers, warnings } = parseCsv("Name,Name,\nx,y,z\n");
    expect(headers).toEqual(["Name", "Name (2)", "Column 3"]);
    expect(warnings).toHaveLength(1);
  });

  it.each([
    ['a\n"unterminated', /not closed/],
    ['a\nab"c', /Unexpected quote/],
    ["", /empty/],
  ])("rejects malformed input %j", (text, message) => {
    expect(() => parseCsv(text)).toThrow(message);
  });

  it("enforces size, row and column limits", () => {
    expect(() => parseCsv("a\n1\n2\n3\n", { maxBytes: 1000, maxRows: 2, maxColumns: 10 })).toThrow(
      CsvError,
    );
    expect(() => parseCsv("a,b,c\n", { maxBytes: 1000, maxRows: 10, maxColumns: 2 })).toThrow(
      /columns/,
    );
    expect(() => parseCsv("x".repeat(100), { maxBytes: 10, maxRows: 10, maxColumns: 10 })).toThrow(
      /larger/,
    );
  });
});
