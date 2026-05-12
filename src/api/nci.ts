import type { SourceHit } from "../types";
import { looksLikeINN } from "../normalize";

const BASE = "https://api-evsrest.nci.nih.gov/api/v1";

export interface NciPartial {
  resolvedINN?: string;
  sources: SourceHit[];
}

interface ConceptSynonym {
  name?: string;
  termType?: string;
  source?: string;
}

interface Concept {
  code?: string;
  name?: string;
  synonyms?: ConceptSynonym[];
}

interface SearchResponse {
  concepts?: Concept[];
}

function pickINN(concept: Concept): string | undefined {
  const syns = concept.synonyms ?? [];
  const fdaPt = syns.find(
    (s) => s.termType === "PT" && s.source === "FDA" && s.name
  );
  if (fdaPt?.name && looksLikeINN(fdaPt.name)) return fdaPt.name.toLowerCase();

  const pt = syns.find((s) => s.termType === "PT" && s.name);
  if (pt?.name && looksLikeINN(pt.name)) return pt.name.toLowerCase();

  for (const s of syns) {
    if (s.name && looksLikeINN(s.name)) return s.name.toLowerCase();
  }
  if (concept.name && looksLikeINN(concept.name))
    return concept.name.toLowerCase();
  return undefined;
}

export async function queryNci(name: string): Promise<NciPartial> {
  const sources: SourceHit[] = [];
  const params = new URLSearchParams({
    terminology: "ncit",
    term: name,
    type: "contains",
    pageSize: "5",
    include: "synonyms",
  });
  const url = `${BASE}/concept/search?${params.toString()}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      sources.push({
        api: "nci/evs",
        url,
        hit: false,
        detail: `HTTP ${r.status}`,
      });
      return { sources };
    }
    const body = (await r.json()) as SearchResponse;
    const concepts = body.concepts ?? [];
    for (const c of concepts) {
      const inn = pickINN(c);
      if (inn) {
        sources.push({
          api: "nci/evs",
          url,
          hit: true,
          detail: `INN=${inn} (${c.code ?? "?"})`,
        });
        return { resolvedINN: inn, sources };
      }
    }
    sources.push({
      api: "nci/evs",
      url,
      hit: false,
      detail: concepts.length === 0 ? "no concepts" : "no INN synonym",
    });
  } catch (e) {
    sources.push({
      api: "nci/evs",
      url,
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
  }
  return { sources };
}
