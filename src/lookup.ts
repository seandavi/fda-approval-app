import { trackEvent } from "./analytics";
import { readCache, writeCache } from "./cache";
import {
  hashName,
  looksLikeInternalId,
  normalizeName,
  stripPharmaSuffixes,
} from "./normalize";
import { queryChembl } from "./api/chembl";
import { queryClinicalTrials } from "./api/clinicaltrials";
import { queryLLM, type LLMPartial } from "./api/llm";
import { queryOpenFdaNdc, type NdcPartial } from "./api/ndc";
import {
  fetchLabelIndicationByAppNum,
  queryOpenFdaDrugsFda,
  queryOpenFdaLabel,
  type OpenFdaPartial,
} from "./api/openfda";
import { queryRxNorm } from "./api/rxnorm";
import type { DrugResult, SourceHit } from "./types";

export interface LookupOptions {
  // When true, the resolver consults the project's /api/llm-lookup proxy
  // (Gemini via Vertex AI) as a last-resort layer for drugs the prior API
  // layers couldn't resolve.
  enableLlmProxy: boolean;
  ttlDays: number;
  useCache: boolean;
}

// Layer numbering (also reflected in About > Data flow):
//   1 = openFDA drugsfda
//   2 = openFDA label
//   3 = openFDA ndc (OTC monograph + unapproved-marketed coverage)
//   4 = RxNorm
//   5 = ChEMBL (ID-to-INN translation)
//   6 = ClinicalTrials.gov (ID-to-INN translation, last resort)
//   7 = LLM (Anthropic) — optional fallback for pre-openFDA drugs (#13)
function emitLayerHit(
  layer: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  normalized: string
): void {
  trackEvent("layer_hit", {
    layer,
    drug_name_hash: hashName(normalized),
  });
}

async function runOpenFdaApprovalLayers(
  name: string,
  sources: SourceHit[]
): Promise<{ approved: OpenFdaPartial | null; layerHit?: 1 | 2 }> {
  const drugsFda = await queryOpenFdaDrugsFda(name);
  sources.push(...drugsFda.sources);
  if (drugsFda.status === "approved" || drugsFda.status === "discontinued") {
    return { approved: drugsFda, layerHit: 1 };
  }
  const label = await queryOpenFdaLabel(name);
  sources.push(...label.sources);
  if (label.status === "approved") {
    return { approved: label, layerHit: 2 };
  }
  return { approved: null };
}

async function runNdc(
  name: string,
  sources: SourceHit[]
): Promise<NdcPartial | null> {
  const ndc = await queryOpenFdaNdc(name);
  sources.push(...ndc.sources);
  if (ndc.status) return ndc;
  return null;
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

// Override-gate molecule check lives in src/molecule.ts so api/openfda.ts
// can reuse it for the cross-query sibling-approved promotion without a
// circular import.
import { sameMolecule } from "./molecule";
export { sameMolecule };

// Detect when the user's query is asking about a specific branded product
// rather than a molecule. Brand-specificity is strict: the query must
// match the pipeline brand_name *exactly* (case-insensitive). Substring
// matches are too permissive — they'd treat "Tecentriq Hybreza" (2024
// subcutaneous co-formulation) and "Lynparza" (whose brand is exactly
// "LYNPARZA") the same way, then accept an LLM "correction" to the IV
// monotherapy "Tecentriq" because brand substring-overlaps. Queries that
// match the generic name are never brand-specific even if they happen to
// also equal the brand_name field (which openFDA fills with the generic
// for ANDAs: brand="CYTARABINE", generic="CYTARABINE").
function queryIsBrandSpecific(
  query: string,
  pipelineBrand: string | undefined,
  pipelineGeneric: string | undefined
): boolean {
  if (!pipelineBrand) return false;
  const q = query.toLowerCase().trim();
  const b = pipelineBrand.toLowerCase().trim();
  if (q.length < 4 || b.length < 4) return false;
  if (pipelineGeneric) {
    const g = pipelineGeneric.toLowerCase().trim();
    if (g === q || g.includes(q) || q.includes(g)) return false;
  }
  return q === b;
}

function shouldOverride(
  result: DrugResult,
  llm: LLMPartial
): boolean {
  if (llm.agreement !== "correct") return false;
  if (llm.confidence !== "high") return false;
  if (!llm.approvalDate || !result.approvalDate) return false;
  // LLM date must be strictly earlier.
  if (llm.approvalDate >= result.approvalDate) return false;
  // At least one full calendar year earlier — avoid bouncing on noise.
  const py = parseInt(result.approvalDate.slice(0, 4), 10);
  const ly = parseInt(llm.approvalDate.slice(0, 4), 10);
  if (!Number.isFinite(py) || !Number.isFinite(ly)) return false;
  if (py - ly < 1) return false;
  if (!sameMolecule(result.genericName, llm.genericName)) return false;
  // Brand-specific queries (e.g. "Rybrevant Faspro", "Lynparza") only get
  // overridden if the LLM's earlier approval is for the *same* brand —
  // otherwise we'd swap in a sibling product with the same molecule but a
  // different formulation/route.
  if (
    queryIsBrandSpecific(
      result.normalizedName,
      result.brandName,
      result.genericName
    )
  ) {
    const pb = (result.brandName ?? "").toLowerCase().trim();
    const lb = (llm.brandName ?? "").toLowerCase().trim();
    // Require strict (case-insensitive) brand equality. Substring matches
    // are too permissive — they'd let "TECENTRIQ" override
    // "TECENTRIQ HYBREZA" because the former is contained in the latter.
    if (!pb || !lb || pb !== lb) return false;
  }
  return true;
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

function applyNdc(result: DrugResult, partial: NdcPartial): void {
  if (partial.status) result.status = partial.status;
  if (partial.resolvedVia) result.resolvedVia = partial.resolvedVia;
  if (partial.brandName) result.brandName = partial.brandName;
  if (partial.genericName) result.genericName = partial.genericName;
  if (partial.sponsor) result.sponsor = partial.sponsor;
  if (partial.marketingCategory)
    result.marketingCategory = partial.marketingCategory;
}

async function tryNameChain(
  result: DrugResult,
  queryName: string
): Promise<boolean> {
  const openfda = await runOpenFdaApprovalLayers(
    queryName,
    result.sources
  );
  if (openfda.approved) {
    applyOpenFda(result, openfda.approved);
    if (openfda.layerHit) emitLayerHit(openfda.layerHit, result.normalizedName);
    return true;
  }
  // NDC fills the OTC monograph / unapproved-marketed gap that drugsfda
  // doesn't cover (aspirin, acetaminophen, ibuprofen — see #6, #7).
  const ndc = await runNdc(queryName, result.sources);
  if (ndc) {
    applyNdc(result, ndc);
    emitLayerHit(3, result.normalizedName);
    return true;
  }
  const rx = await runRxNorm(queryName, result.sources);
  if (rx) {
    result.status = "approved";
    result.applicationNumber = rx.applicationNumber;
    result.applicationType = rx.applicationType;
    result.resolvedVia = "rxnorm";
    emitLayerHit(4, result.normalizedName);
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
      if (await tryNameChain(result, candidate)) {
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      const chembl = await queryChembl(normalized);
      result.sources.push(...chembl.sources);
      if (chembl.resolvedINN) {
        result.resolvedINN = chembl.resolvedINN;
        emitLayerHit(5, result.normalizedName);
        if (await tryNameChain(result, chembl.resolvedINN)) {
          if (!result.resolvedVia) result.resolvedVia = "chembl";
          resolved = true;
        }
      }
    }

    if (!resolved) {
      const ct = await queryClinicalTrials(normalized);
      result.sources.push(...ct.sources);
      if (ct.resolvedINN && ct.resolvedINN !== result.resolvedINN) {
        result.resolvedINN = ct.resolvedINN;
        emitLayerHit(6, result.normalizedName);
        if (await tryNameChain(result, ct.resolvedINN)) {
          if (!result.resolvedVia) result.resolvedVia = "clinicaltrials";
          resolved = true;
        }
      }
    }

    if (!resolved) result.status = "not_found";

    // Layer 7: invoke the LLM as an arbiter, not just a last-resort fallback.
    //
    // We pass the deterministic-pipeline candidate (if any) to the model and
    // ask it to confirm or correct. This catches the dominant failure mode
    // in #13 — openFDA returns *some* match (a later ANDA or reformulation
    // NDA) so the pipeline short-circuits, but the original innovator NDA
    // is missing from openFDA entirely (Doxorubicin 1974, Tamoxifen 1977,
    // Velban 1965, etc.).
    //
    // Authoritative non-NDA statuses from the NDC layer (otc_monograph,
    // unapproved_marketed) are not arbitrable — the LLM doesn't see them.
    if (
      opts.enableLlmProxy &&
      result.status !== "otc_monograph" &&
      result.status !== "unapproved_marketed"
    ) {
      // Fetch the resolved application's label `indications_and_usage` to
      // give the arbiter semantic grounding. Skipped when we have no
      // application number — the model then verifies on structured fields
      // and its training knowledge, same as the pre-grounding behavior.
      if (result.applicationNumber) {
        const labelInd = await fetchLabelIndicationByAppNum(
          result.applicationNumber
        );
        result.sources.push(...labelInd.sources);
        if (labelInd.indicationText) {
          result.labelIndicationText = labelInd.indicationText;
        }
      }
      const pipelineFinding =
        result.status === "approved" || result.status === "discontinued"
          ? {
              status: result.status,
              applicationNumber: result.applicationNumber,
              applicationType: result.applicationType,
              approvalDate: result.approvalDate,
              brandName: result.brandName,
              genericName: result.genericName,
              resolvedVia: result.resolvedVia,
              labelIndicationText: result.labelIndicationText,
            }
          : undefined;
      const llm = await queryLLM(normalized, {
        enableProxy: opts.enableLlmProxy,
        pipelineFinding,
      });
      result.sources.push(...llm.sources);
      if (llm.agreement) result.llmAgreement = llm.agreement;
      if (llm.confidence) result.llmConfidence = llm.confidence;
      if (llm.rationale) result.llmRationale = llm.rationale;
      // Indications are assigned unconditionally here, but the override
      // block below clears `currentIndications` if the LLM corrects to a
      // different application — the verbatim list was extracted from the
      // rejected pipeline candidate's label, not the corrected one.
      // `originalIndication` is the model's training-knowledge answer
      // about the molecule's first approval and remains valid either way.
      if (llm.currentIndications && llm.currentIndications.length > 0) {
        result.currentIndications = llm.currentIndications;
      }
      if (llm.originalIndication) {
        result.originalIndication = llm.originalIndication;
      }

      const llmHasAnswer =
        !!llm.status && llm.status !== "not_found";

      if (pipelineFinding && llmHasAnswer) {
        if (shouldOverride(result, llm)) {
          // Preserve the pipeline's finding for the audit trail / CSV.
          result.pipelineApplicationNumber = result.applicationNumber;
          result.pipelineApprovalDate = result.approvalDate;
          result.pipelineResolvedVia = result.resolvedVia;
          result.status = llm.status!;
          result.applicationNumber = llm.applicationNumber;
          result.applicationType = llm.applicationType;
          result.approvalDate = llm.approvalDate;
          result.brandName = llm.brandName ?? result.brandName;
          result.genericName = llm.genericName ?? result.genericName;
          result.sponsor = llm.sponsor ?? result.sponsor;
          result.resolvedVia = "llm";
          // The label text we fetched belongs to the *rejected* pipeline
          // application. Try to refetch a label for the LLM-proposed app
          // so the indications attach to the right application. When the
          // refetch hits, we replace the text and drop the arbiter's
          // enumerated bullets (they were extracted from the prior label
          // and don't necessarily match the new one). When the refetch
          // misses — common for original innovator NDAs that pre-date
          // openFDA's online window, e.g. imatinib NDA021335 (#45) — we
          // keep the pipeline's text and bullets: shouldOverride already
          // gated on same-molecule, so the indications are valid for the
          // resolved drug even though sourced from a sibling application.
          // The arbiter card surfaces pipelineApplicationNumber, so the
          // provenance stays in the audit trail.
          if (result.applicationNumber) {
            const refetch = await fetchLabelIndicationByAppNum(
              result.applicationNumber,
              opts.apiKey
            );
            result.sources.push(...refetch.sources);
            if (refetch.indicationText) {
              result.labelIndicationText = refetch.indicationText;
              result.indicationApplicationNumber = result.applicationNumber;
              result.currentIndications = undefined;
            } else if (result.labelIndicationText) {
              result.indicationApplicationNumber =
                result.pipelineApplicationNumber;
            }
          }
          emitLayerHit(7, result.normalizedName);
        } else if (result.labelIndicationText && result.applicationNumber) {
          // No override — indications stay attached to the pipeline-resolved
          // application. Record the provenance explicitly so the UI can
          // distinguish "from this app" from the override-fallback case
          // above.
          result.indicationApplicationNumber = result.applicationNumber;
        }
      } else if (!pipelineFinding && llmHasAnswer) {
        // Nothing else found this drug — accept the LLM if it's
        // high-confidence. Same rule as the old last-resort fallback.
        if (llm.confidence === "high") {
          result.status = llm.status!;
          result.resolvedVia = "llm";
          if (llm.brandName) result.brandName = llm.brandName;
          if (llm.genericName) result.genericName = llm.genericName;
          if (llm.applicationNumber)
            result.applicationNumber = llm.applicationNumber;
          if (llm.applicationType) result.applicationType = llm.applicationType;
          if (llm.approvalDate) result.approvalDate = llm.approvalDate;
          if (llm.sponsor) result.sponsor = llm.sponsor;
          emitLayerHit(7, result.normalizedName);
        }
      }
    }
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
