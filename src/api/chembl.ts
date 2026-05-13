import type { SourceHit } from "../types";

const BASE = "https://www.ebi.ac.uk/chembl/api/data";

export interface ChemblPartial {
  resolvedINN?: string;
  sources: SourceHit[];
}

interface MoleculeSynonym {
  molecule_synonym?: string;
  synonyms?: string;
  syn_type?: string;
}

interface Molecule {
  pref_name?: string;
  molecule_chembl_id?: string;
  molecule_synonyms?: MoleculeSynonym[];
}

interface MoleculeResponse {
  molecules?: Molecule[];
}

function pickInnFromMolecule(mol: Molecule): string | undefined {
  const syns = mol.molecule_synonyms ?? [];
  // ChEMBL exposes syn_type, so we can ask for INN directly instead of
  // guessing. Fall back to FDA, then USAN, then the pref_name.
  for (const target of ["INN", "FDA", "USAN"]) {
    for (const s of syns) {
      if (s.syn_type === target) {
        const v = s.synonyms ?? s.molecule_synonym;
        if (v) return v.toLowerCase();
      }
    }
  }
  if (mol.pref_name) return mol.pref_name.toLowerCase();
  return undefined;
}

// Generate hyphenation/spacing variants of a research code. ChEMBL stores
// these inconsistently — AGS-22CE is indexed but ASG22CE may not be, AMG 107
// might exist but AMG107 may not. We try the original first, then variants.
export function idVariants(name: string): string[] {
  const out: string[] = [name];
  const seen = new Set([name]);
  const push = (v: string): void => {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  push(name.replace(/([A-Za-z])(\d)/, "$1-$2"));
  push(name.replace(/([A-Za-z])(\d)/, "$1 $2"));
  push(name.replace(/-/g, ""));
  push(name.replace(/\s+/g, ""));
  return out;
}

async function queryChemblExact(
  name: string
): Promise<{ inn?: string; url: string; detail: string }> {
  const params = new URLSearchParams({
    molecule_synonyms__molecule_synonym__iexact: name,
    limit: "3",
  });
  const url = `${BASE}/molecule.json?${params.toString()}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { url, detail: `HTTP ${r.status}` };
    const body = (await r.json()) as MoleculeResponse;
    const molecules = body.molecules ?? [];
    for (const mol of molecules) {
      const inn = pickInnFromMolecule(mol);
      if (inn) {
        return {
          inn,
          url,
          detail: `INN=${inn} (${mol.molecule_chembl_id ?? "?"})`,
        };
      }
    }
    return {
      url,
      detail: molecules.length === 0 ? "no molecules" : "no INN/USAN synonym",
    };
  } catch (e) {
    return { url, detail: e instanceof Error ? e.message : "fetch failed" };
  }
}

export async function queryChembl(name: string): Promise<ChemblPartial> {
  const sources: SourceHit[] = [];
  for (const variant of idVariants(name)) {
    const res = await queryChemblExact(variant);
    sources.push({
      api: variant === name ? "chembl" : `chembl (variant: ${variant})`,
      url: res.url,
      hit: !!res.inn,
      detail: res.detail,
    });
    if (res.inn) return { resolvedINN: res.inn, sources };
  }
  return { sources };
}
