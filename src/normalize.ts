const TRADEMARK_RE = /[®™©]/g;
const STRIPPABLE_SUFFIXES = [
  " injection",
  " injectable",
  " tablets",
  " tablet",
  " capsules",
  " capsule",
  " oral solution",
  " solution",
  " hcl",
  " hydrochloride",
  " sodium",
  " sulfate",
];

export function normalizeName(raw: string): string {
  return raw
    .replace(TRADEMARK_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripPharmaSuffixes(name: string): string {
  let out = name.toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of STRIPPABLE_SUFFIXES) {
      if (out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

const INTERNAL_ID_RE = /^[A-Z]{1,5}[- ]?\d{2,7}[A-Z]?$/;

export function looksLikeInternalId(name: string): boolean {
  const cleaned = name.replace(/\s+/g, "").toUpperCase();
  return INTERNAL_ID_RE.test(cleaned);
}

export function looksLikeINN(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length < 5) return false;
  if (/\d/.test(trimmed)) return false;
  if (/[A-Z]{3,}/.test(trimmed)) return false;
  return /^[a-zA-Z][a-zA-Z\- ]+$/.test(trimmed);
}

export function hashName(normalized: string): string {
  try {
    return btoa(normalized).slice(0, 8);
  } catch {
    return normalized.slice(0, 8);
  }
}

export function parseBatchInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
