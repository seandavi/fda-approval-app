// Shared salt-suffix vocabulary for matching base INN ↔ salt-form
// variants. Three call sites:
//   - api/openfda.ts: isSaltSuffixMatch (strong-match filter for drugsfda)
//   - api/ndc.ts: nameMatches (NDC-layer ingredient matching)
//   - molecule.ts: sameMolecule (arbiter override gate)
//
// Pre-#30 each call site had its own copy; adding a new salt form (e.g.
// fda eventually publishing labels with a new suffix) only required
// remembering to update three places without telling you when you missed
// one. Now all three import this list.

export const SALT_SUFFIXES = [
  "hydrochloride", "hcl", "sodium", "potassium", "calcium", "magnesium",
  "sulfate", "sulphate", "phosphate", "acetate", "tartrate", "succinate",
  "fumarate", "maleate", "citrate", "tosylate", "mesylate", "besylate",
  "edisylate", "esylate", "lactate", "gluconate", "bromide", "chloride",
  "iodide", "nitrate", "carbonate", "bicarbonate", "hemihydrate", "dihydrate",
  "monohydrate", "anhydrous",
] as const;

// "free base" / "base" are markers for the unsalted form openFDA
// occasionally uses. Treated as a salt suffix for matching purposes since
// they participate in the same "base INN ↔ formal product name" relation.
const BASE_MARKERS = ["free base", "base"] as const;

// Regex form: matches a recognized salt suffix at the start of a string,
// followed by whitespace or end-of-string. Used by ndc.ts for the tail of
// `<base> <tail>` candidates.
export const SALT_SUFFIX_RE = new RegExp(
  `^(?:${[...SALT_SUFFIXES, ...BASE_MARKERS].join("|")})(?:\\s|$)`
);

// Pre-built set for O(1) membership tests. Used by openfda.ts and
// molecule.ts where the full tail is already isolated.
export const SALT_SUFFIX_SET = new Set<string>(SALT_SUFFIXES);

// Returns true when `candidate` is `<base> <salt-form-suffix> [tail...]`.
// Tail must START with a recognized salt suffix; additional tokens after
// it are allowed (e.g. "doxorubicin hydrochloride monohydrate").
export function isSaltSuffixMatch(base: string, candidate: string): boolean {
  if (!candidate.startsWith(`${base} `)) return false;
  const tail = candidate.slice(base.length + 1);
  return SALT_SUFFIX_RE.test(tail);
}
