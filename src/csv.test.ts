import { describe, expect, it } from "vitest";
import { buildCsv, csvArrayField, csvField, UTF8_BOM } from "./csv";

describe("csvField", () => {
  it("wraps every value in double quotes, even bare ASCII", () => {
    expect(csvField("hello")).toBe('"hello"');
  });

  it("renders null/undefined as empty quoted string", () => {
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
  });

  it("doubles internal double quotes per RFC 4180", () => {
    expect(csvField('She said "hi"')).toBe('"She said ""hi"""');
  });

  it("preserves embedded commas inside the quotes", () => {
    expect(csvField("aspirin, ibuprofen")).toBe('"aspirin, ibuprofen"');
  });

  it("preserves embedded newlines inside the quotes", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("preserves pipes (not the field separator)", () => {
    expect(csvField("a|b|c")).toBe('"a|b|c"');
  });

  it("coerces numbers and booleans to strings before quoting", () => {
    expect(csvField(42)).toBe('"42"');
    expect(csvField(true)).toBe('"true"');
  });
});

describe("csvArrayField", () => {
  it("pipe-joins a non-empty array inside quotes", () => {
    expect(csvArrayField(["melanoma", "NSCLC"])).toBe('"melanoma|NSCLC"');
  });

  it("emits empty quoted string for empty or undefined arrays", () => {
    expect(csvArrayField([])).toBe('""');
    expect(csvArrayField(undefined)).toBe('""');
  });

  it("replaces stray pipes inside array entries (preserves array integrity)", () => {
    // A rogue pipe inside a string would silently break round-tripping
    // back to an array consumer. Replace with `/` rather than failing.
    expect(csvArrayField(["a|b", "c"])).toBe('"a/b|c"');
  });

  it("preserves commas and quotes inside array entries", () => {
    expect(csvArrayField(['advanced "BRCA" cancer, line 2'])).toBe(
      '"advanced ""BRCA"" cancer, line 2"'
    );
  });
});

describe("buildCsv", () => {
  it("emits BOM, CRLF line endings, and a final newline", () => {
    const csv = buildCsv(
      [{ a: "1", b: "2" }],
      [
        { header: "a", pick: (r) => r.a },
        { header: "b", pick: (r) => r.b },
      ]
    );
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv.includes("\r\n")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    // After BOM + headers + data, exactly two CRLFs.
    const sansBom = csv.slice(UTF8_BOM.length);
    expect(sansBom.split("\r\n").filter((l) => l.length > 0)).toEqual([
      '"a","b"',
      '"1","2"',
    ]);
  });

  it("supports pickArray columns (pipe-joined inside cell)", () => {
    const csv = buildCsv(
      [{ name: "x", indications: ["melanoma", "NSCLC"] }],
      [
        { header: "name", pick: (r) => r.name },
        { header: "indications", pickArray: (r) => r.indications },
      ]
    );
    expect(csv).toContain('"melanoma|NSCLC"');
  });

  it("quotes a cell containing a newline so the row structure survives", () => {
    const csv = buildCsv(
      [{ text: "line1\nline2" }],
      [{ header: "text", pick: (r) => r.text }]
    );
    // The newline lives inside the quoted field — total row count must
    // still be 2 (header + one data row).
    const sansBom = csv.slice(UTF8_BOM.length);
    const matches = sansBom.match(/\r\n/g) ?? [];
    expect(matches.length).toBe(2); // after header, after data row
  });

  it("emits an empty data section when the rows array is empty", () => {
    const csv = buildCsv<{ a: string }>(
      [],
      [{ header: "a", pick: (r) => r.a }]
    );
    // Just header + final CRLF
    expect(csv).toBe(`${UTF8_BOM}"a"\r\n\r\n`);
  });
});
