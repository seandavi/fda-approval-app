import { sameMolecule } from "../molecule";
import type { ApprovalStatus, ResolvedVia, SourceHit } from "../types";

const OPENFDA_BASE = "https://api.fda.gov";

export interface OpenFdaPartial {
  status?: ApprovalStatus;
  resolvedVia?: ResolvedVia;
  applicationNumber?: string;
  applicationType?: "NDA" | "BLA" | "ANDA";
  brandName?: string;
  genericName?: string;
  approvalDate?: string;
  sponsor?: string;
  sources: SourceHit[];
}

interface DrugsFdaSubmission {
  submission_type?: string;
  submission_number?: string;
  submission_status?: string;
  submission_status_date?: string;
}

interface DrugsFdaProduct {
  marketing_status?: string;
  brand_name?: string;
}

interface DrugsFdaResult {
  application_number?: string;
  sponsor_name?: string;
  submissions?: DrugsFdaSubmission[];
  products?: DrugsFdaProduct[];
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    application_number?: string[];
    substance_name?: string[];
  };
}

interface LabelResult {
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    application_number?: string[];
  };
  marketing_category?: string[] | string;
  indications_and_usage?: string[];
}

function appType(num: string | undefined): "NDA" | "BLA" | "ANDA" | undefined {
  if (!num) return undefined;
  if (num.startsWith("BLA")) return "BLA";
  if (num.startsWith("ANDA")) return "ANDA";
  if (num.startsWith("NDA")) return "NDA";
  return undefined;
}

function formatDate(yyyymmdd: string | undefined): string | undefined {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function fetchWithBackoff(url: string): Promise<Response> {
  const r = await fetch(url);
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 2000));
    return fetch(url);
  }
  return r;
}

// Keep the real URL for fetching, but never store the api_key in SourceHit
// records — they're rendered to the UI and exported to CSV.
function redact(url: string): string {
  return url.replace(/([?&]api_key=)[^&]*/i, "$1REDACTED");
}

function buildDrugsFdaUrl(
  field: "brand_name" | "generic_name",
  name: string,
  apiKey: string,
  wildcard: boolean
): string {
  // openFDA tokenizes on whitespace. A naked multi-token wildcard like
  // `mecbotamab vedotin*` parses as `mecbotamab` OR `vedotin*` and pulls in
  // every -vedotin drug (Polivy, Adcetris, Padcev, ...). The wildcard pass
  // is only safe on single-token names — callers must guard against
  // wildcard=true with a multi-token name (see queryDrugsFda).
  const value = wildcard ? `${name}*` : `"${name}"`;
  const params = new URLSearchParams({
    search: `openfda.${field}:${value}`,
    limit: "10",
  });
  if (apiKey) params.set("api_key", apiKey);
  return `${OPENFDA_BASE}/drug/drugsfda.json?${params.toString()}`;
}

// Common salt suffixes openFDA stores in product names. We treat
// "tamoxifen citrate", "vinblastine sulfate", "doxorubicin hydrochloride"
// etc. as strong matches for the base INN — only when the product is
// single-ingredient (substance_name length 1), so we don't conflate combo
// products whose generic happens to start with a queried token (issue #13).
const SALT_SUFFIXES = [
  "hydrochloride", "hcl", "sodium", "potassium", "calcium", "magnesium",
  "sulfate", "sulphate", "phosphate", "acetate", "tartrate", "succinate",
  "fumarate", "maleate", "citrate", "tosylate", "mesylate", "besylate",
  "edisylate", "esylate", "lactate", "gluconate", "bromide", "chloride",
  "iodide", "nitrate", "carbonate", "bicarbonate", "hemihydrate", "dihydrate",
  "monohydrate", "anhydrous", "free base", "base",
];

function isSaltSuffixMatch(query: string, candidate: string): boolean {
  if (!candidate.startsWith(`${query} `)) return false;
  const tail = candidate.slice(query.length + 1);
  return SALT_SUFFIXES.some((s) => tail === s || tail.startsWith(`${s} `));
}

// openFDA's brand_name/generic_name indexes are token-based: a query for
// "aspirin" matches every combination product whose name contains the
// token. Without this filter, "aspirin" resolves to ASPIRIN AND
// EXTENDED-RELEASE DIPYRIDAMOLE (Aggrenox), which is misleading. We accept
// a result only if (a) the brand_name is an exact match — even for combo
// products like RYBREVANT FASPRO, OPDUALAG, TECENTRIQ HYBREZA, MYFEMBREE
// whose distinct brand identity isn't ambiguous (#13), (b) it's a
// single-ingredient product whose ingredient matches the query exactly or
// as a salt-form variant (#6, #13).
function isStrongDrugsFdaMatch(query: string, r: DrugsFdaResult): boolean {
  const q = query.toLowerCase();
  const substances = (r.openfda?.substance_name ?? []).map((s) => s.toLowerCase());
  const brands = (r.openfda?.brand_name ?? []).map((s) => s.toLowerCase());
  const generics = (r.openfda?.generic_name ?? []).map((s) => s.toLowerCase());
  if (brands.includes(q)) return true;
  if (substances.length === 1) {
    const s = substances[0];
    if (s === q || isSaltSuffixMatch(q, s)) return true;
  }
  if (substances.length <= 1) {
    if (generics.includes(q)) return true;
    for (const g of generics) if (isSaltSuffixMatch(q, g)) return true;
  }
  return false;
}

// Application-type priority for tie-breaking. We want the original
// innovator approval for a molecule, not the first ANDA generic openFDA
// happens to return. NDA/BLA outrank ANDA; within a class, earlier
// approval-date wins.
function appTypeRank(num: string | undefined): number {
  if (!num) return 0;
  if (num.startsWith("BLA")) return 3;
  if (num.startsWith("NDA")) return 3;
  if (num.startsWith("ANDA")) return 1;
  return 0;
}

interface RankedMatch {
  result: DrugsFdaResult;
  earliestAp: string;
  rank: number;
}

function resultAllDiscontinued(r: DrugsFdaResult): boolean {
  const products = r.products ?? [];
  return (
    products.length > 0 &&
    products.every((p) => p.marketing_status === "Discontinued")
  );
}

function interpretDrugsFda(
  query: string,
  results: DrugsFdaResult[]
): Omit<OpenFdaPartial, "sources" | "resolvedVia"> {
  const candidates: RankedMatch[] = [];
  for (const r of results) {
    if (!isStrongDrugsFdaMatch(query, r)) continue;
    const approvals = (r.submissions ?? []).filter(
      (s) => s.submission_status === "AP"
    );
    if (approvals.length === 0) continue;
    const earliest = approvals
      .map((s) => s.submission_status_date)
      .filter((d): d is string => !!d)
      .sort()[0];
    if (!earliest) continue;
    candidates.push({
      result: r,
      earliestAp: earliest,
      rank: appTypeRank(r.application_number),
    });
  }
  if (candidates.length === 0) return {};

  // Prefer NDA/BLA over ANDA; within a class, earliest approval date wins
  // (so 5FU → original 1962 NDA rather than a recent ANDA).
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    return a.earliestAp.localeCompare(b.earliestAp);
  });
  const best = candidates[0];
  const r = best.result;

  // The winner has the "original" identity (preferred app type, earliest
  // date). But if the winner's products are all discontinued while a
  // sibling candidate for the same molecule is still being marketed, the
  // *molecule* is still approved — only this specific product line is
  // gone (e.g. duloxetine #33: original Cymbalta NDA021427 is
  // discontinued but the molecule lives on in approved generic ANDAs).
  // Keep the winner's appnum + date but promote status to "approved".
  const winnerDiscontinued = resultAllDiscontinued(r);
  const anyOtherApproved = candidates
    .slice(1)
    .some((c) => !resultAllDiscontinued(c.result));
  const status =
    winnerDiscontinued && !anyOtherApproved ? "discontinued" : "approved";

  return {
    status,
    applicationNumber: r.application_number,
    applicationType: appType(r.application_number),
    brandName: r.openfda?.brand_name?.[0] ?? r.products?.[0]?.brand_name,
    genericName: r.openfda?.generic_name?.[0],
    approvalDate: formatDate(best.earliestAp),
    sponsor: r.sponsor_name,
  };
}

async function queryDrugsFda(
  field: "brand_name" | "generic_name",
  name: string,
  apiKey: string
): Promise<OpenFdaPartial> {
  const sources: SourceHit[] = [];
  const api = `openfda/drugsfda (${field})`;

  // Skip the wildcard pass for multi-token names — see buildDrugsFdaUrl.
  const passes = name.includes(" ") ? [false] : [false, true];
  for (const wildcard of passes) {
    const url = buildDrugsFdaUrl(field, name, apiKey, wildcard);
    try {
      const r = await fetchWithBackoff(url);
      if (r.status === 404) {
        sources.push({ api, url: redact(url), hit: false, detail: "no results" });
        continue;
      }
      if (!r.ok) {
        sources.push({ api, url: redact(url), hit: false, detail: `HTTP ${r.status}` });
        continue;
      }
      const body = (await r.json()) as { results?: DrugsFdaResult[] };
      const results = body.results ?? [];
      if (results.length === 0) {
        sources.push({ api, url: redact(url), hit: false, detail: "empty results" });
        continue;
      }
      const interp = interpretDrugsFda(name, results);
      if (interp.status) {
        sources.push({
          api,
          url: redact(url),
          hit: true,
          detail: `${interp.status} ${interp.applicationNumber ?? ""}`.trim(),
        });
        return {
          ...interp,
          resolvedVia: field === "brand_name" ? "openfda_brand" : "openfda_generic",
          sources,
        };
      }
      sources.push({ api, url: redact(url), hit: false, detail: "no AP submission" });
    } catch (e) {
      sources.push({
        api,
        url: redact(url),
        hit: false,
        detail: e instanceof Error ? e.message : "fetch failed",
      });
    }
  }
  return { sources };
}

// Pick whichever of two candidate partials represents a better original
// approval: prefer NDA/BLA over ANDA, then earlier approval date. Mirrors
// the per-query ranking in interpretDrugsFda — picking the better of two
// best-of-query results is mathematically equivalent to running the
// ranker on the merged candidate list, since both rules are monotone.
function preferEarlierOriginal(
  a: OpenFdaPartial,
  b: OpenFdaPartial
): OpenFdaPartial {
  if (!a.status) return b;
  if (!b.status) return a;
  const ra = appTypeRank(a.applicationNumber);
  const rb = appTypeRank(b.applicationNumber);
  if (ra !== rb) return ra > rb ? a : b;
  const da = a.approvalDate ?? "9999-99-99";
  const db = b.approvalDate ?? "9999-99-99";
  return da.localeCompare(db) <= 0 ? a : b;
}

export async function queryOpenFdaDrugsFda(
  name: string,
  apiKey: string
): Promise<OpenFdaPartial> {
  // Always run both brand and generic searches and pick the stronger
  // result. Pre-fix this short-circuited at brand: "capecitabine" matched
  // generic ANDAs labeled brand_name=CAPECITABINE and never saw Xeloda
  // NDA020896 (1998) sitting in the generic-search result set (#13).
  // The two searches are independent — parallelize them (#29).
  const [byBrand, byGeneric] = await Promise.all([
    queryDrugsFda("brand_name", name, apiKey),
    queryDrugsFda("generic_name", name, apiKey),
  ]);
  const combinedSources = [...byBrand.sources, ...byGeneric.sources];
  const winner = preferEarlierOriginal(byBrand, byGeneric);

  // Cross-query sibling-approved promotion (#33). If the winner's products
  // are discontinued but the losing query found an approved sibling
  // application for the same molecule, the molecule is still on the market
  // — keep the winner's identity (original NDA appnum + date) but report
  // status as "approved". Same logic as within interpretDrugsFda but at
  // the brand+generic merge boundary. Gated on same-molecule so brand
  // and generic queries that happen to resolve to different molecules
  // can't cross-promote each other (post-#36 review).
  const loser = winner === byBrand ? byGeneric : byBrand;
  const sameMoleculeAsLoser = sameMolecule(
    winner.genericName,
    loser.genericName
  );
  const promoted =
    winner.status === "discontinued" &&
    loser.status === "approved" &&
    sameMoleculeAsLoser
      ? { ...winner, status: "approved" as const }
      : winner;

  return { ...promoted, sources: combinedSources };
}

export async function queryOpenFdaLabel(
  name: string,
  apiKey: string
): Promise<OpenFdaPartial> {
  const sources: SourceHit[] = [];
  const api = "openfda/label";
  const params = new URLSearchParams({
    search: `openfda.brand_name:"${name}"`,
    limit: "3",
  });
  if (apiKey) params.set("api_key", apiKey);
  const url = `${OPENFDA_BASE}/drug/label.json?${params.toString()}`;

  try {
    const r = await fetchWithBackoff(url);
    if (r.status === 404) {
      sources.push({ api, url: redact(url), hit: false, detail: "no results" });
      return { sources };
    }
    if (!r.ok) {
      sources.push({ api, url: redact(url), hit: false, detail: `HTTP ${r.status}` });
      return { sources };
    }
    const body = (await r.json()) as { results?: LabelResult[] };
    const results = body.results ?? [];
    for (const res of results) {
      const appNum = res.openfda?.application_number?.[0];
      const cat = Array.isArray(res.marketing_category)
        ? res.marketing_category[0]
        : res.marketing_category;
      const type = appType(appNum);
      if (type && (cat === "NDA" || cat === "BLA")) {
        sources.push({
          api,
          url: redact(url),
          hit: true,
          detail: `${cat} ${appNum}`,
        });
        return {
          status: "approved",
          resolvedVia: "openfda_label",
          applicationNumber: appNum,
          applicationType: type,
          brandName: res.openfda?.brand_name?.[0],
          genericName: res.openfda?.generic_name?.[0],
          sources,
        };
      }
    }
    sources.push({
      api,
      url: redact(url),
      hit: false,
      detail: results.length === 0 ? "empty" : "no NDA/BLA label",
    });
  } catch (e) {
    sources.push({
      api,
      url: redact(url),
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
  }
  return { sources };
}

export interface LabelIndicationFetch {
  indicationText?: string;
  sources: SourceHit[];
}

// Strip the boilerplate header that prefixes most modern openFDA labels.
// Real example: "HIGHLIGHTS OF PRESCRIBING INFORMATION These highlights do
// not include all the information needed to use KEYTRUDA safely and
// effectively. See full prescribing information for KEYTRUDA."
// We keep everything from the first real indication line onward.
const LABEL_BOILERPLATE_PATTERNS: RegExp[] = [
  /^HIGHLIGHTS OF PRESCRIBING INFORMATION[\s\S]*?(?=\b\d+\s+INDICATIONS|\bINDICATIONS AND USAGE)/i,
  /These highlights do not include all the information needed[\s\S]*?prescribing information[^.]*\.\s*/i,
  /See full prescribing information[^.]*\.\s*/gi,
];

function stripLabelBoilerplate(text: string): string {
  let out = text;
  for (const pat of LABEL_BOILERPLATE_PATTERNS) {
    out = out.replace(pat, "");
  }
  return out.trim();
}

// Fetch the current label's `indications_and_usage` text for a specific FDA
// application. Used as semantic grounding for the Layer 7 arbiter — feeding
// the model the actual approved indications dramatically reduces the
// hallucination rate on close-call verifications.
//
// Returns `indicationText: undefined` when the label has no indications
// section, or when openFDA has no current label record indexed by app#.
// Errors are recorded in `sources` but never thrown — the arbiter can run
// without this grounding and degrades gracefully.
// Pick the most useful label record from a results page. openFDA can
// return multiple SPL records per application_number — different sponsors,
// reformulations, or generic versions of the same NDA. We:
//   1) prefer entries whose marketing_category is the original NDA/BLA
//      (skips generic-ANDA labels that mirror the original);
//   2) within that, pick the one with the longest indications_and_usage
//      (longer text is virtually always the more current, fully-supplemented
//      label — withdrawn indications are deletions, additions are the rule);
//   3) fall back to the first entry with any indications_and_usage if no
//      NDA/BLA category is present.
function pickBestLabelResult(
  results: LabelResult[]
): { result: LabelResult; rawIndication: string } | null {
  type Candidate = { r: LabelResult; raw: string; isOriginal: boolean };
  const candidates: Candidate[] = [];
  for (const r of results) {
    const raw = r.indications_and_usage?.[0];
    if (!raw || !raw.trim()) continue;
    const cat = Array.isArray(r.marketing_category)
      ? r.marketing_category[0]
      : r.marketing_category;
    candidates.push({
      r,
      raw,
      isOriginal: cat === "NDA" || cat === "BLA",
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.isOriginal !== b.isOriginal) return a.isOriginal ? -1 : 1;
    return b.raw.length - a.raw.length;
  });
  return { result: candidates[0].r, rawIndication: candidates[0].raw };
}

export async function fetchLabelIndicationByAppNum(
  applicationNumber: string,
  apiKey: string
): Promise<LabelIndicationFetch> {
  const sources: SourceHit[] = [];
  const api = "openfda/label (by appnum)";

  // openFDA stores application_number padded — keep whatever caller gave us
  // (drugsfda already returns "NDA125514"-shape strings). We request up to
  // 5 results so that pickBestLabelResult can choose the most current /
  // complete label among possible duplicates rather than relying on
  // openFDA's unspecified result order.
  const params = new URLSearchParams({
    search: `openfda.application_number:"${applicationNumber}"`,
    limit: "5",
  });
  if (apiKey) params.set("api_key", apiKey);
  const url = `${OPENFDA_BASE}/drug/label.json?${params.toString()}`;

  try {
    const r = await fetchWithBackoff(url);
    if (r.status === 404) {
      sources.push({ api, url: redact(url), hit: false, detail: "no label" });
      return { sources };
    }
    if (!r.ok) {
      sources.push({
        api,
        url: redact(url),
        hit: false,
        detail: `HTTP ${r.status}`,
      });
      return { sources };
    }
    const body = (await r.json()) as { results?: LabelResult[] };
    const results = body.results ?? [];
    if (results.length === 0) {
      sources.push({ api, url: redact(url), hit: false, detail: "empty" });
      return { sources };
    }
    const best = pickBestLabelResult(results);
    if (!best) {
      sources.push({
        api,
        url: redact(url),
        hit: false,
        detail: "no indications section",
      });
      return { sources };
    }
    const cleaned = stripLabelBoilerplate(best.rawIndication);
    if (!cleaned) {
      // Boilerplate stripping ate everything — defensive: treat as no usable
      // grounding rather than reporting a "successful" 0-char hit.
      sources.push({
        api,
        url: redact(url),
        hit: false,
        detail: "no indications after stripping boilerplate",
      });
      return { sources };
    }
    sources.push({
      api,
      url: redact(url),
      hit: true,
      detail: `${cleaned.length} chars`,
    });
    return { indicationText: cleaned, sources };
  } catch (e) {
    sources.push({
      api,
      url: redact(url),
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
    return { sources };
  }
}
