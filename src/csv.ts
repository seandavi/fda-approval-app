// Excel-friendly RFC 4180 CSV writer.
//
// Design rules (#24):
//   - Every field is quoted, including ints/dates. Eliminates ambiguity
//     around "safe" fields and is bulletproof against later schema
//     additions that happen to contain a comma.
//   - Internal `"` doubled to `""` (RFC 4180 standard).
//   - Line ending: CRLF — matches RFC 4180 and Excel-on-Windows.
//   - UTF-8 BOM prepended to the file so Excel-on-Windows auto-detects
//     UTF-8 and doesn't mangle non-ASCII characters as Latin-1.
//   - Array fields are pipe-joined inside their cell. Pipe is near-zero
//     collision with FDA label text; comma collides with the field
//     separator and semicolon collides in EU Excel locales.
//   - Newlines inside fields are preserved as literal `\n` between the
//     quotes — Excel handles them correctly when the field is quoted.

const FIELD_SEP = ",";
const ROW_SEP = "\r\n";
const ARRAY_SEP = "|";
export const UTF8_BOM = "﻿";

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const s = String(value).replace(/"/g, '""');
  return `"${s}"`;
}

export function csvArrayField(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return '""';
  // Defensive: drop any pipes that might appear inside an indication string.
  // openFDA label text doesn't use pipes in practice, but a single rogue
  // pipe would silently break the round-trip back to an array consumer.
  const cleaned = values.map((v) => v.replace(/\|/g, "/"));
  return csvField(cleaned.join(ARRAY_SEP));
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvField).join(FIELD_SEP) + ROW_SEP;
}

// Build a complete UTF-8 BOM + CRLF CSV string from a header row and a
// column-projector list. Each row is constructed by applying each
// column's `pick` function — array columns may use `csvArrayField`
// directly via a pick that returns the pipe-joined string, OR be flagged
// `isArray: true` and provide `pickArray` instead.
export interface CsvColumn<T> {
  header: string;
  pick?: (r: T) => unknown;
  pickArray?: (r: T) => readonly string[] | undefined;
}

export function buildCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => csvField(c.header)).join(FIELD_SEP);
  const dataLines = rows.map((r) =>
    columns
      .map((c) =>
        c.pickArray ? csvArrayField(c.pickArray(r)) : csvField(c.pick?.(r))
      )
      .join(FIELD_SEP)
  );
  return UTF8_BOM + headerLine + ROW_SEP + dataLines.join(ROW_SEP) + ROW_SEP;
}
