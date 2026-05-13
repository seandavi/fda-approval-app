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

// Internal/research codes vary in shape: MK-3475, AZD9291, BA3011, ASG22CE,
// AGS-22CE. Allow up to a 3-letter trailing suffix after the digit block
// (covers conjugate naming like -CE, -ME, -MSE) without admitting random
// alphanumeric tokens.
const INTERNAL_ID_RE = /^[A-Z]{1,5}[- ]?\d{2,7}[- ]?[A-Z]{0,3}$/;

export function looksLikeInternalId(name: string): boolean {
  const cleaned = name.replace(/\s+/g, "").toUpperCase();
  return INTERNAL_ID_RE.test(cleaned);
}

// WHO INN stems — drugs are conventionally suffixed by class (e.g. -mab for
// monoclonal antibodies, -nib for kinase inhibitors). Matching against the
// recognized set lets us pick INNs out of a mixed synonym list without false
// positives from brand names.
const INN_STEMS = [
  "mab", "nib", "tinib", "ciclib", "rafenib", "zumab", "lizumab", "tuximab",
  "prazole", "sartan", "statin", "olol", "pril", "dipine", "fenac",
  "parin", "gliflozin", "gliptin", "glitazone",
  "vir", "navir", "mivir", "ciclovir",
  "tide", "actide", "relix", "tropin",
  "limus", "fosmid", "stat",
  "afil", "setron", "triptan", "azepam", "barbital",
  "icin", "mycin", "cycline", "cillin", "floxacin", "azole",
  "estradiol", "progesterone", "testosterone",
  "oxetine", "sertraline",
];

const INN_STEM_RE = new RegExp(`(?:${INN_STEMS.join("|")})$`, "i");

export function looksLikeINN(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length < 6) return false;
  if (/\d/.test(trimmed)) return false;
  if (/[A-Z]{2,}/.test(trimmed)) return false;          // brands like Cytoxan, HUMIRA
  if (!/^[a-zA-Z][a-zA-Z\- ]+$/.test(trimmed)) return false;
  // Multi-word INNs (e.g. "mecbotamab vedotin", ADC names) only need one
  // token to carry a recognized stem — usually the antibody half (-mab).
  return trimmed.split(/\s+/).some((part) => INN_STEM_RE.test(part));
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
