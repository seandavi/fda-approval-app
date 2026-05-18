// Strict molecule-name equality used in two places:
//   - lookup.ts: the Layer 7 arbiter override gate (#31)
//   - api/openfda.ts: the cross-query sibling-approved promotion in
//     queryOpenFdaDrugsFda (#33 + post-#36 review)
//
// Two names match iff they are the same INN (case-insensitive), the same
// INN with a salt-form suffix (e.g. "tamoxifen citrate", "doxorubicin
// hydrochloride monohydrate"), or the same INN with a biosimilar-style
// four-letter suffix ("pembrolizumab-aaaa"). Anything else returns false
// — substring overlaps like "iron" vs "iron sucrose" or "furosemide" vs
// "furosemide and amiloride" are rejected.
//
// The salt-suffix list mirrors the one in src/api/openfda.ts; #30 will
// consolidate the salt-form helpers into a single canonical source.

const MOLECULE_SALT_SUFFIXES = new Set([
  "hydrochloride", "hcl", "sodium", "potassium", "calcium", "magnesium",
  "sulfate", "sulphate", "phosphate", "acetate", "tartrate", "succinate",
  "fumarate", "maleate", "citrate", "tosylate", "mesylate", "besylate",
  "edisylate", "esylate", "lactate", "gluconate", "bromide", "chloride",
  "iodide", "nitrate", "carbonate", "bicarbonate", "hemihydrate", "dihydrate",
  "monohydrate", "anhydrous",
]);

// candidate must be "base SUFFIX" or "base SUFFIX trailing-tokens" where
// SUFFIX is a recognized salt form. Allows tails like "hydrochloride
// monohydrate" or "sodium hemihydrate" that the FDA actually uses, while
// still rejecting unrelated tails like "and amiloride".
function isSaltFormOf(base: string, candidate: string): boolean {
  if (!candidate.startsWith(`${base} `)) return false;
  const tail = candidate.slice(base.length + 1).trim();
  if (!tail) return false;
  // First trailing token must be a recognized salt suffix (or "base" /
  // "free base" — the unsalted form marker openFDA occasionally uses).
  const firstSpace = tail.indexOf(" ");
  const head = firstSpace < 0 ? tail : tail.slice(0, firstSpace);
  if (head === "free" && tail.startsWith("free base")) return true;
  if (head === "base") return true;
  return MOLECULE_SALT_SUFFIXES.has(head);
}

function isBiosimilarOf(base: string, candidate: string): boolean {
  // FDA biosimilar suffix: a hyphenated four-letter code, e.g.
  // "pembrolizumab-aaaa", "filgrastim-sndz".
  return /^[a-z]{4}$/.test(candidate.slice(base.length + 1)) &&
    candidate.startsWith(`${base}-`);
}

export function sameMolecule(
  a: string | undefined,
  b: string | undefined
): boolean {
  if (!a || !b) return true; // can't disprove → allow
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;
  // Order-insensitive: try each direction for both salt and biosimilar.
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return isSaltFormOf(shorter, longer) || isBiosimilarOf(shorter, longer);
}
