import type { SourceHit } from "../types";
import { looksLikeINN } from "../normalize";

const BASE = "https://clinicaltrials.gov/api/v2";

export interface CtPartial {
  resolvedINN?: string;
  sources: SourceHit[];
}

interface Study {
  protocolSection?: {
    armsInterventionsModule?: {
      interventions?: Array<{
        name?: string;
        otherNames?: string[];
      }>;
    };
  };
}

interface StudiesResponse {
  studies?: Study[];
}

export async function queryClinicalTrials(name: string): Promise<CtPartial> {
  const sources: SourceHit[] = [];
  const params = new URLSearchParams({
    "query.intr": name,
    fields: "InterventionName,InterventionOtherName",
    pageSize: "5",
  });
  const url = `${BASE}/studies?${params.toString()}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      sources.push({
        api: "clinicaltrials",
        url,
        hit: false,
        detail: `HTTP ${r.status}`,
      });
      return { sources };
    }
    const body = (await r.json()) as StudiesResponse;
    const lowerName = name.toLowerCase();
    // Match the queried token in a few common formattings: bare "BA3011",
    // hyphenated "BA-3011", spaced "BA 3011".
    const tokenForms = new Set([
      lowerName,
      lowerName.replace(/-/g, ""),
      lowerName.replace(/-/g, " "),
      lowerName.replace(/([a-z])(\d)/, "$1-$2"),
      lowerName.replace(/([a-z])(\d)/, "$1 $2"),
    ]);
    const candidates = new Set<string>();

    // The intervention name must be exactly the token (modulo a trailing
    // dose suffix like "BA3011 50 mg") — substring match would let combo
    // interventions ("BA3011 + cyclophosphamide") leak co-drug names
    // through otherNames.
    const ivMatchesToken = (ivName: string): boolean => {
      const trimmed = ivName.toLowerCase().trim();
      if (tokenForms.has(trimmed)) return true;
      const firstWord = trimmed.split(/\s+/)[0] ?? "";
      return tokenForms.has(firstWord);
    };

    for (const study of body.studies ?? []) {
      const interventions =
        study.protocolSection?.armsInterventionsModule?.interventions ?? [];
      for (const iv of interventions) {
        if (!ivMatchesToken(iv.name ?? "")) continue;
        for (const n of iv.otherNames ?? []) candidates.add(n);
      }
    }

    for (const cand of candidates) {
      if (cand.toLowerCase() === lowerName) continue;
      if (looksLikeINN(cand)) {
        sources.push({
          api: "clinicaltrials",
          url,
          hit: true,
          detail: `INN=${cand}`,
        });
        return { resolvedINN: cand.toLowerCase(), sources };
      }
    }
    sources.push({
      api: "clinicaltrials",
      url,
      hit: false,
      detail: candidates.size === 0 ? "no interventions" : "no INN candidate",
    });
  } catch (e) {
    sources.push({
      api: "clinicaltrials",
      url,
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
  }
  return { sources };
}
