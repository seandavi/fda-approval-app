import type { ApprovalStatus, ResolvedVia, SourceHit } from "../types";
import { fetchWithBackoff } from "./_http";
import { SALT_SUFFIX_RE } from "./salts";

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

function nameMatches(query: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const c = candidate.toLowerCase();
  if (c === query) return true;
  if (c.startsWith(`${query} `)) {
    return SALT_SUFFIX_RE.test(c.slice(query.length + 1));
  }
  return false;
}

// Accept results where (a) the brand_name is an exact match — including
// combination products with distinct brand identity (Rybrevant Faspro,
// Tecentriq Hybreza, Opdualag), or (b) the product is single-ingredient and
// the ingredient/generic matches the query exactly or as a salt form. We
// still reject token-substring combos like Aggrenox for "aspirin" (#6, #13).
function isStrongMatch(query: string, r: NdcResult): boolean {
  const q = query.toLowerCase();
  if (nameMatches(q, r.brand_name)) return true;
  const ingredients = r.active_ingredients ?? [];
  if (ingredients.length === 1) {
    if (nameMatches(q, ingredients[0].name)) return true;
    if (nameMatches(q, r.generic_name)) return true;
  }
  return false;
}

async function queryField(
  field: "brand_name" | "generic_name",
  name: string
): Promise<NdcPartial> {
  const sources: SourceHit[] = [];
  const api = `openfda/ndc (${field})`;
  const params = new URLSearchParams({
    search: `${field}:"${name}"`,
    limit: "20",
  });
  const url = `${OPENFDA_BASE}/drug/ndc.json?${params.toString()}`;

  try {
    const r = await fetchWithBackoff(url);
    if (r.status === 404) {
      sources.push({ api, url, hit: false, detail: "no results" });
      return { sources };
    }
    if (!r.ok) {
      sources.push({ api, url, hit: false, detail: `HTTP ${r.status}` });
      return { sources };
    }
    const body = (await r.json()) as { results?: NdcResult[] };
    const results = body.results ?? [];
    if (results.length === 0) {
      sources.push({ api, url, hit: false, detail: "empty results" });
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
        url,
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
      url,
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
      url,
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
    return { sources };
  }
}

export async function queryOpenFdaNdc(
  name: string
): Promise<NdcPartial> {
  // Try brand_name first (matches things like "Tylenol"), then generic.
  const byBrand = await queryField("brand_name", name);
  if (byBrand.status) return byBrand;
  const byGeneric = await queryField("generic_name", name);
  return {
    ...byGeneric,
    sources: [...byBrand.sources, ...byGeneric.sources],
  };
}
