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
    const candidates = new Set<string>();

    // Only collect otherNames from interventions whose canonical name
    // contains the queried ID. This avoids picking co-administered drugs
    // from combination trials (e.g. pembro + cyclophosphamide → "Cytoxan").
    for (const study of body.studies ?? []) {
      const interventions =
        study.protocolSection?.armsInterventionsModule?.interventions ?? [];
      for (const iv of interventions) {
        const ivName = (iv.name ?? "").toLowerCase();
        if (!ivName.includes(lowerName)) continue;
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
