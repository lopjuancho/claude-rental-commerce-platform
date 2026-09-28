import { describe, expect, it } from "vitest";
import { sniffMediaType } from "@/domain/media/sniff";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts
      .flatMap((p) => (typeof p === "string" ? Array.from(new TextEncoder().encode(p)) : p))
      .concat(new Array(16).fill(0)),
  );

describe("sniffMediaType", () => {
  it.each([
    [bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    [bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [bytes("RIFF", [0, 0, 0, 0], "WEBP"), "image/webp"],
    [bytes([0, 0, 0, 0x1c], "ftypavif"), "image/avif"],
    [bytes([0, 0, 0, 0x18], "ftypisom"), "video/mp4"],
  ])("detects %#", (input, type) => {
    expect(sniffMediaType(input)).toBe(type);
  });

  it.each([
    ["an SVG (scriptable) file", bytes("<svg xmlns=")],
    ["HTML renamed to .jpg", bytes("<!doctype html>")],
    ["a PDF", bytes("%PDF-1.7")],
    ["a tiny file", new Uint8Array([0xff, 0xd8])],
    ["a QuickTime file", bytes([0, 0, 0, 0x14], "ftypqt  ")],
  ])("rejects %s", (_label, input) => {
    expect(sniffMediaType(input)).toBeNull();
  });
});
