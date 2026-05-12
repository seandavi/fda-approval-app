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

export async function queryChembl(name: string): Promise<ChemblPartial> {
  const sources: SourceHit[] = [];
  // Exact-match synonym search: hits brand names, research codes, INNs, USANs.
  const params = new URLSearchParams({
    molecule_synonyms__molecule_synonym__iexact: name,
    limit: "3",
  });
  const url = `${BASE}/molecule.json?${params.toString()}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      sources.push({
        api: "chembl",
        url,
        hit: false,
        detail: `HTTP ${r.status}`,
      });
      return { sources };
    }
    const body = (await r.json()) as MoleculeResponse;
    const molecules = body.molecules ?? [];
    for (const mol of molecules) {
      const inn = pickInnFromMolecule(mol);
      if (inn) {
        sources.push({
          api: "chembl",
          url,
          hit: true,
          detail: `INN=${inn} (${mol.molecule_chembl_id ?? "?"})`,
        });
        return { resolvedINN: inn, sources };
      }
    }
    sources.push({
      api: "chembl",
      url,
      hit: false,
      detail: molecules.length === 0 ? "no molecules" : "no INN/USAN synonym",
    });
  } catch (e) {
    sources.push({
      api: "chembl",
      url,
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
  }
  return { sources };
}
