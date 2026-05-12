import type { ApprovalStatus, ResolvedVia, SourceHit } from "../types";

const OPENFDA_BASE = "https://api.fda.gov";

export interface NdcPartial {
  status?: ApprovalStatus;
  resolvedVia?: ResolvedVia;
  marketingCategory?: string;
  brandName?: string;
  genericName?: string;
  sponsor?: string;
  sources: SourceHit[];
}

interface ActiveIngredient {
  name?: string;
  strength?: string;
}

interface NdcResult {
  product_ndc?: string;
  brand_name?: string;
  generic_name?: string;
  labeler_name?: string;
  marketing_category?: string;
  marketing_start_date?: string;
  marketing_end_date?: string;
  active_ingredients?: ActiveIngredient[];
}

function redact(url: string): string {
  return url.replace(/([?&]api_key=)[^&]*/i, "$1REDACTED");
}

async function fetchWithBackoff(url: string): Promise<Response> {
  const r = await fetch(url);
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 2000));
    return fetch(url);
  }
  return r;
}

// Map marketing_category vocabulary to our internal status. Approval-path
// categories take precedence; OTC monograph is its own status; everything
// else marketed-without-approval collapses into unapproved_marketed.
function statusFor(category: string | undefined): ApprovalStatus | undefined {
  if (!category) return undefined;
  const c = category.toUpperCase();
  if (c === "NDA" || c === "BLA" || c === "ANDA" || c === "NDA AUTHORIZED GENERIC") {
    return "approved";
  }
  if (c.startsWith("OTC MONOGRAPH")) return "otc_monograph";
  if (c.startsWith("UNAPPROVED")) return "unapproved_marketed";
  return undefined; // BULK INGREDIENT, KIT, STANDARDIZED ALLERGENIC, etc.
}

// Single-ingredient exact match is the only result quality we accept here.
// A multi-ingredient product (e.g. Aggrenox for "aspirin") would mislead.
function isStrongMatch(query: string, r: NdcResult): boolean {
  const q = query.toLowerCase();
  const ingredients = r.active_ingredients ?? [];
  if (ingredients.length !== 1) return false;
  const ingName = (ingredients[0].name ?? "").toLowerCase();
  if (ingName === q) return true;
  // Also accept exact generic_name or brand_name match on the queried token,
  // in case the API formats the ingredient name with extra qualifiers.
  if ((r.generic_name ?? "").toLowerCase() === q) return true;
  if ((r.brand_name ?? "").toLowerCase() === q) return true;
  return false;
}

async function queryField(
  field: "brand_name" | "generic_name",
  name: string,
  apiKey: string
): Promise<NdcPartial> {
  const sources: SourceHit[] = [];
  const api = `openfda/ndc (${field})`;
  const params = new URLSearchParams({
    search: `${field}:"${name}"`,
    limit: "20",
  });
  if (apiKey) params.set("api_key", apiKey);
  const url = `${OPENFDA_BASE}/drug/ndc.json?${params.toString()}`;
  const safeUrl = redact(url);

  try {
    const r = await fetchWithBackoff(url);
    if (r.status === 404) {
      sources.push({ api, url: safeUrl, hit: false, detail: "no results" });
      return { sources };
    }
    if (!r.ok) {
      sources.push({ api, url: safeUrl, hit: false, detail: `HTTP ${r.status}` });
      return { sources };
    }
    const body = (await r.json()) as { results?: NdcResult[] };
    const results = body.results ?? [];
    if (results.length === 0) {
      sources.push({ api, url: safeUrl, hit: false, detail: "empty results" });
      return { sources };
    }

    // Rank: prefer single-ingredient exact matches, then prefer approval
    // categories over monograph over unapproved.
    const ranked = results
      .filter((r) => isStrongMatch(name, r))
      .filter((r) => statusFor(r.marketing_category) !== undefined);
    if (ranked.length === 0) {
      sources.push({
        api,
        url: safeUrl,
        hit: false,
        detail: `${results.length} weak/combo results — no single-ingredient exact match`,
      });
      return { sources };
    }

    const statusPriority: Record<ApprovalStatus, number> = {
      approved: 3,
      otc_monograph: 2,
      unapproved_marketed: 1,
      // others shouldn't appear here but listed for completeness
      discontinued: 0,
      not_found: 0,
      pending: 0,
      error: 0,
    };
    ranked.sort((a, b) => {
      const sa = statusFor(a.marketing_category)!;
      const sb = statusFor(b.marketing_category)!;
      return (statusPriority[sb] ?? 0) - (statusPriority[sa] ?? 0);
    });
    const best = ranked[0];
    const status = statusFor(best.marketing_category)!;

    sources.push({
      api,
      url: safeUrl,
      hit: true,
      detail: `${status} (${best.marketing_category})`,
    });

    return {
      status,
      resolvedVia: "openfda_ndc",
      marketingCategory: best.marketing_category,
      brandName: best.brand_name,
      genericName: best.generic_name,
      sponsor: best.labeler_name,
      sources,
    };
  } catch (e) {
    sources.push({
      api,
      url: safeUrl,
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
    return { sources };
  }
}

export async function queryOpenFdaNdc(
  name: string,
  apiKey: string
): Promise<NdcPartial> {
  // Try brand_name first (matches things like "Tylenol"), then generic.
  const byBrand = await queryField("brand_name", name, apiKey);
  if (byBrand.status) return byBrand;
  const byGeneric = await queryField("generic_name", name, apiKey);
  return {
    ...byGeneric,
    sources: [...byBrand.sources, ...byGeneric.sources],
  };
}
