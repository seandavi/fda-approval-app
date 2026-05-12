import { trackEvent } from "./analytics";
import { readCache, writeCache } from "./cache";
import {
  hashName,
  looksLikeInternalId,
  normalizeName,
  stripPharmaSuffixes,
} from "./normalize";
import { queryClinicalTrials } from "./api/clinicaltrials";
import { queryNci } from "./api/nci";
import {
  queryOpenFdaDrugsFda,
  queryOpenFdaLabel,
  type OpenFdaPartial,
} from "./api/openfda";
import { queryRxNorm } from "./api/rxnorm";
import type { DrugResult, SourceHit } from "./types";

export interface LookupOptions {
  apiKey: string;
  ttlDays: number;
  useCache: boolean;
}

function emitLayerHit(layer: 1 | 2 | 3 | 4 | 5, normalized: string): void {
  trackEvent("layer_hit", {
    layer,
    drug_name_hash: hashName(normalized),
  });
}

async function runOpenFdaLayers(
  name: string,
  apiKey: string,
  sources: SourceHit[]
): Promise<{ approved: OpenFdaPartial | null; layerHit?: 1 | 2 }> {
  const drugsFda = await queryOpenFdaDrugsFda(name, apiKey);
  sources.push(...drugsFda.sources);
  if (drugsFda.status === "approved" || drugsFda.status === "discontinued") {
    return { approved: drugsFda, layerHit: 1 };
  }
  const label = await queryOpenFdaLabel(name, apiKey);
  sources.push(...label.sources);
  if (label.status === "approved") {
    return { approved: label, layerHit: 2 };
  }
  return { approved: null };
}

async function runRxNorm(
  name: string,
  sources: SourceHit[]
): Promise<{
  applicationNumber?: string;
  applicationType?: "NDA" | "BLA" | "ANDA";
} | null> {
  const rx = await queryRxNorm(name);
  sources.push(...rx.sources);
  if (rx.applicationNumber && rx.applicationType) {
    return {
      applicationNumber: rx.applicationNumber,
      applicationType: rx.applicationType,
    };
  }
  return null;
}

function applyOpenFda(result: DrugResult, partial: OpenFdaPartial): void {
  if (partial.status) result.status = partial.status;
  if (partial.resolvedVia) result.resolvedVia = partial.resolvedVia;
  if (partial.applicationNumber)
    result.applicationNumber = partial.applicationNumber;
  if (partial.applicationType) result.applicationType = partial.applicationType;
  if (partial.brandName) result.brandName = partial.brandName;
  if (partial.genericName) result.genericName = partial.genericName;
  if (partial.approvalDate) result.approvalDate = partial.approvalDate;
  if (partial.sponsor) result.sponsor = partial.sponsor;
}

async function tryNameChain(
  result: DrugResult,
  queryName: string,
  apiKey: string
): Promise<boolean> {
  const openfda = await runOpenFdaLayers(queryName, apiKey, result.sources);
  if (openfda.approved) {
    applyOpenFda(result, openfda.approved);
    if (openfda.layerHit) emitLayerHit(openfda.layerHit, result.normalizedName);
    return true;
  }
  const rx = await runRxNorm(queryName, result.sources);
  if (rx) {
    result.status = "approved";
    result.applicationNumber = rx.applicationNumber;
    result.applicationType = rx.applicationType;
    result.resolvedVia = "rxnorm";
    emitLayerHit(3, result.normalizedName);
    return true;
  }
  return false;
}

export async function lookupDrug(
  inputName: string,
  opts: LookupOptions
): Promise<DrugResult> {
  const normalized = normalizeName(inputName);

  if (opts.useCache) {
    const cached = readCache(normalized, opts.ttlDays);
    if (cached) {
      trackEvent("drug_resolved", {
        status: cached.status,
        resolved_via: cached.resolvedVia ?? "none",
        was_cached: true,
        had_id_translation: !!cached.resolvedINN,
      });
      return cached;
    }
  }

  const result: DrugResult = {
    inputName,
    normalizedName: normalized,
    status: "not_found",
    sources: [],
    cached: false,
    lookedUpAt: new Date().toISOString(),
  };

  try {
    const isInternal = looksLikeInternalId(normalized);
    const namesToTry = isInternal
      ? [normalized]
      : [normalized, stripPharmaSuffixes(normalized)].filter(
          (n, i, arr) => arr.indexOf(n) === i
        );

    let resolved = false;
    for (const candidate of namesToTry) {
      if (await tryNameChain(result, candidate, opts.apiKey)) {
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      const nci = await queryNci(normalized);
      result.sources.push(...nci.sources);
      if (nci.resolvedINN) {
        result.resolvedINN = nci.resolvedINN;
        emitLayerHit(4, result.normalizedName);
        if (await tryNameChain(result, nci.resolvedINN, opts.apiKey)) {
          if (!result.resolvedVia) result.resolvedVia = "nci";
          resolved = true;
        }
      }
    }

    if (!resolved) {
      const ct = await queryClinicalTrials(normalized);
      result.sources.push(...ct.sources);
      if (ct.resolvedINN && ct.resolvedINN !== result.resolvedINN) {
        result.resolvedINN = ct.resolvedINN;
        emitLayerHit(5, result.normalizedName);
        if (await tryNameChain(result, ct.resolvedINN, opts.apiKey)) {
          if (!result.resolvedVia) result.resolvedVia = "clinicaltrials";
          resolved = true;
        }
      }
    }

    if (!resolved) result.status = "not_found";
  } catch (e) {
    result.status = "error";
    result.sources.push({
      api: "orchestrator",
      url: "",
      hit: false,
      detail: e instanceof Error ? e.message : "unknown error",
    });
  }

  result.lookedUpAt = new Date().toISOString();
  if (opts.useCache && result.status !== "error") writeCache(result);

  trackEvent("drug_resolved", {
    status: result.status,
    resolved_via: result.resolvedVia ?? "none",
    was_cached: false,
    had_id_translation: !!result.resolvedINN,
  });

  return result;
}

export async function lookupBatch(
  inputs: string[],
  opts: LookupOptions,
  onProgress: (completed: number, result: DrugResult) => void,
  concurrency = 5
): Promise<DrugResult[]> {
  const results: DrugResult[] = new Array(inputs.length);
  let next = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= inputs.length) return;
      const r = await lookupDrug(inputs[i], opts);
      results[i] = r;
      completed += 1;
      onProgress(completed, r);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
