import type { SourceHit } from "../types";
import { fetchWithBackoff } from "./_http";

const BASE = "https://rxnav.nlm.nih.gov/REST";

export interface RxNormPartial {
  applicationNumber?: string;
  applicationType?: "NDA" | "BLA" | "ANDA";
  rxcui?: string;
  sources: SourceHit[];
}

interface DrugsResponse {
  drugGroup?: {
    conceptGroup?: Array<{
      conceptProperties?: Array<{ rxcui?: string; name?: string }>;
    }>;
  };
}

interface PropertyResponse {
  propConceptGroup?: {
    propConcept?: Array<{ propName?: string; propValue?: string }>;
  };
}

function appType(num: string): "NDA" | "BLA" | "ANDA" | undefined {
  if (num.startsWith("BLA")) return "BLA";
  if (num.startsWith("ANDA")) return "ANDA";
  if (num.startsWith("NDA")) return "NDA";
  return undefined;
}

export async function queryRxNorm(name: string): Promise<RxNormPartial> {
  const sources: SourceHit[] = [];
  const drugsUrl = `${BASE}/drugs.json?name=${encodeURIComponent(name)}`;
  let rxcui: string | undefined;

  try {
    const r = await fetchWithBackoff(drugsUrl);
    if (!r.ok) {
      sources.push({
        api: "rxnorm/drugs",
        url: drugsUrl,
        hit: false,
        detail: `HTTP ${r.status}`,
      });
      return { sources };
    }
    const body = (await r.json()) as DrugsResponse;
    for (const g of body.drugGroup?.conceptGroup ?? []) {
      for (const c of g.conceptProperties ?? []) {
        if (c.rxcui) {
          rxcui = c.rxcui;
          break;
        }
      }
      if (rxcui) break;
    }
    sources.push({
      api: "rxnorm/drugs",
      url: drugsUrl,
      hit: !!rxcui,
      detail: rxcui ? `rxcui=${rxcui}` : "no rxcui",
    });
  } catch (e) {
    sources.push({
      api: "rxnorm/drugs",
      url: drugsUrl,
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
    return { sources };
  }

  if (!rxcui) return { sources };

  const propUrl = `${BASE}/rxcui/${rxcui}/property.json?propName=FDA_APPLICATION_NUMBER`;
  try {
    const r = await fetchWithBackoff(propUrl);
    if (!r.ok) {
      sources.push({
        api: "rxnorm/property",
        url: propUrl,
        hit: false,
        detail: `HTTP ${r.status}`,
      });
      return { sources, rxcui };
    }
    const body = (await r.json()) as PropertyResponse;
    const props = body.propConceptGroup?.propConcept ?? [];
    for (const p of props) {
      const v = p.propValue;
      if (!v) continue;
      const type = appType(v);
      if (type) {
        sources.push({
          api: "rxnorm/property",
          url: propUrl,
          hit: true,
          detail: v,
        });
        return {
          rxcui,
          applicationNumber: v,
          applicationType: type,
          sources,
        };
      }
    }
    sources.push({
      api: "rxnorm/property",
      url: propUrl,
      hit: false,
      detail: "no NDA/BLA/ANDA",
    });
  } catch (e) {
    sources.push({
      api: "rxnorm/property",
      url: propUrl,
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
  }
  return { sources, rxcui };
}
