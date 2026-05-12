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
  const value = wildcard ? `${name}*` : `"${name}"`;
  const params = new URLSearchParams({
    search: `openfda.${field}:${value}`,
    limit: "5",
  });
  if (apiKey) params.set("api_key", apiKey);
  return `${OPENFDA_BASE}/drug/drugsfda.json?${params.toString()}`;
}

// openFDA's brand_name/generic_name indexes are token-based: a query for
// "aspirin" matches every combination product whose name contains the
// token. Without this filter, "aspirin" resolves to ASPIRIN AND
// EXTENDED-RELEASE DIPYRIDAMOLE (Aggrenox), which is misleading. We only
// accept a result if it's a single-ingredient product whose ingredient
// matches the query (#6).
function isStrongDrugsFdaMatch(query: string, r: DrugsFdaResult): boolean {
  const q = query.toLowerCase();
  const substances = (r.openfda?.substance_name ?? []).map((s) => s.toLowerCase());
  if (substances.length === 1 && substances[0] === q) return true;
  // Fall back to exact brand_name / generic_name match — some entries don't
  // populate substance_name but have a clean name field.
  const brands = (r.openfda?.brand_name ?? []).map((s) => s.toLowerCase());
  const generics = (r.openfda?.generic_name ?? []).map((s) => s.toLowerCase());
  if (substances.length <= 1 && (brands.includes(q) || generics.includes(q)))
    return true;
  return false;
}

function interpretDrugsFda(
  query: string,
  results: DrugsFdaResult[]
): Omit<OpenFdaPartial, "sources" | "resolvedVia"> {
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

    const allDiscontinued =
      (r.products ?? []).length > 0 &&
      (r.products ?? []).every((p) => p.marketing_status === "Discontinued");

    return {
      status: allDiscontinued ? "discontinued" : "approved",
      applicationNumber: r.application_number,
      applicationType: appType(r.application_number),
      brandName: r.openfda?.brand_name?.[0] ?? r.products?.[0]?.brand_name,
      genericName: r.openfda?.generic_name?.[0],
      approvalDate: formatDate(earliest),
      sponsor: r.sponsor_name,
    };
  }
  return {};
}

async function queryDrugsFda(
  field: "brand_name" | "generic_name",
  name: string,
  apiKey: string
): Promise<OpenFdaPartial> {
  const sources: SourceHit[] = [];
  const api = `openfda/drugsfda (${field})`;

  for (const wildcard of [false, true]) {
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

export async function queryOpenFdaDrugsFda(
  name: string,
  apiKey: string
): Promise<OpenFdaPartial> {
  const byBrand = await queryDrugsFda("brand_name", name, apiKey);
  if (byBrand.status) return byBrand;
  const byGeneric = await queryDrugsFda("generic_name", name, apiKey);
  return {
    ...byGeneric,
    sources: [...byBrand.sources, ...byGeneric.sources],
  };
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
