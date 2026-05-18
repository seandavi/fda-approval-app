import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchMock } from "./test/fetchMock";
import { lookupDrug, sameMolecule } from "./lookup";

// Layer 7 (Gemini via /api/llm-lookup) integration tests. These pin down the
// arbiter behavior from issue #13 — strict brand-equality gating, generic-
// name precedence, override thresholds — using mocked fetches against the
// same FetchMock infrastructure the rest of the resolver tests use.

const OPTS = {
  enableLlmProxy: true,
  ttlDays: 7,
  useCache: false,
};

const EMPTY_FDA = { meta: { results: { total: 0 } }, results: [] };
const EMPTY_NDC = { meta: { results: { total: 0 } }, results: [] };
const EMPTY_LABEL = { meta: { results: { total: 0 } }, results: [] };
const EMPTY_CT = { studies: [] };
const EMPTY_CHEMBL = { molecules: [] };
const EMPTY_RXNORM = { drugGroup: { conceptGroup: [] } };

// Build a payload shaped like what the Netlify function returns: an
// Anthropic-style message body wrapping the JSON the model produced.
function llmPayload(json: Record<string, unknown>) {
  return {
    model: "gemini-3.1-flash-lite",
    region: "global",
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(json) }],
    },
  };
}

// Stub every non-LLM API to "empty" so we only need to vary the layer that
// the test cares about.
function stubAllEmpty(mock: FetchMock): void {
  mock.on("/drug/drugsfda.json", EMPTY_FDA);
  mock.on("/drug/label.json", EMPTY_LABEL);
  mock.on("/drug/ndc.json", EMPTY_NDC);
  mock.on("rxcui.json", EMPTY_RXNORM);
  mock.on("rxnav.nlm.nih.gov", EMPTY_RXNORM);
  mock.on("ebi.ac.uk/chembl", EMPTY_CHEMBL);
  mock.on("clinicaltrials.gov", EMPTY_CT);
}

// drugsfda response shape that puts a single approved result into Layer 1
// candidates. Tests use this to seed the pipeline with a "found something
// in openFDA" baseline and then assert what the arbiter does with it.
function drugsfdaApproved(opts: {
  appNum: string;
  date: string;
  brand: string;
  generic: string;
}): Record<string, unknown> {
  return {
    meta: { results: { total: 1 } },
    results: [
      {
        application_number: opts.appNum,
        sponsor_name: "ACME",
        submissions: [
          {
            submission_type: "ORIG",
            submission_status: "AP",
            submission_status_date: opts.date,
          },
        ],
        products: [{ marketing_status: "Prescription", brand_name: opts.brand }],
        openfda: {
          brand_name: [opts.brand],
          generic_name: [opts.generic],
          substance_name: [opts.generic],
        },
      },
    ],
  };
}

describe("lookupDrug — Layer 7 LLM arbiter", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("overrides pipeline ANDA with LLM-proposed earlier NDA (bare-generic query)", async () => {
    // Pre-fix: pipeline returns the only thing in openFDA (a 1990 ANDA) and
    // Layer 7 never runs. Post-fix: arbiter consults the LLM, which
    // proposes the 1969 original — same molecule, ≥1y earlier, generic
    // query → override allowed.
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "ANDA071868",
        date: "19900604",
        brand: "CYTARABINE",
        generic: "CYTARABINE",
      })
    );
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "high",
        application_number: "NDA016406",
        application_type: "NDA",
        approval_date: "1969-06-24",
        brand_name: "Cytosar-U",
        generic_name: "cytarabine",
        rationale: "Original Cytosar-U NDA predates openFDA's online window.",
      })
    );
    mock.install();

    const r = await lookupDrug("Cytarabine", OPTS);

    expect(r.status).toBe("approved");
    expect(r.resolvedVia).toBe("llm");
    expect(r.applicationNumber).toBe("NDA016406");
    expect(r.approvalDate).toBe("1969-06-24");
    expect(r.pipelineApplicationNumber).toBe("ANDA071868");
    expect(r.pipelineApprovalDate).toBe("1990-06-04");
    expect(r.llmAgreement).toBe("correct");
  });

  it("blocks brand-specific override when LLM proposes a different brand", async () => {
    // "Tecentriq Hybreza" is a 2024 SC co-formulation. The LLM would happily
    // "correct" it to the 2016 IV "Tecentriq" — same molecule, same prefix.
    // The brand-specific gate must reject this since the query exactly
    // matches the pipeline brand and the LLM's brand is different.
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "BLA761347",
        date: "20240912",
        brand: "TECENTRIQ HYBREZA",
        generic: "ATEZOLIZUMAB AND HYALURONIDASE-TQJS",
      })
    );
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "high",
        application_number: "BLA761034",
        application_type: "BLA",
        approval_date: "2016-05-18",
        brand_name: "Tecentriq",
        generic_name: "atezolizumab",
        rationale: "The IV formulation predates the SC co-formulation.",
      })
    );
    mock.install();

    const r = await lookupDrug("Tecentriq Hybreza", OPTS);

    expect(r.applicationNumber).toBe("BLA761347");
    expect(r.approvalDate).toBe("2024-09-12");
    expect(r.resolvedVia).toBe("openfda_brand");
    // No override, but the rationale is still recorded for audit.
    expect(r.llmAgreement).toBe("correct");
    expect(r.pipelineApplicationNumber).toBeUndefined();
  });

  it("allows brand-specific override when LLM proposes the same brand at an earlier date (Lynparza capsule)", async () => {
    // Lynparza-the-brand has two NDAs in FDA's history: NDA206162 (2014
    // capsule, original; later withdrawn) and NDA208558 (2017 tablet,
    // current). openFDA only surfaces 208558. The arbiter should accept
    // the LLM's 2014 capsule because both records carry the same brand.
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "NDA208558",
        date: "20170817",
        brand: "LYNPARZA",
        generic: "OLAPARIB",
      })
    );
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "high",
        application_number: "NDA206162",
        application_type: "NDA",
        approval_date: "2014-12-19",
        brand_name: "LYNPARZA",
        generic_name: "olaparib",
        rationale: "Original capsule formulation under the same brand.",
      })
    );
    mock.install();

    const r = await lookupDrug("Lynparza", OPTS);

    expect(r.applicationNumber).toBe("NDA206162");
    expect(r.approvalDate).toBe("2014-12-19");
    expect(r.resolvedVia).toBe("llm");
    expect(r.pipelineApplicationNumber).toBe("NDA208558");
  });

  it("allows family-style query override (Lupron query vs Lupron Depot pipeline)", async () => {
    // The user types "Lupron"; openFDA exposes both "LUPRON" and
    // "LUPRON DEPOT" brand strings on the same NDA. Query is shorter than
    // the pipeline brand_name we'd display, so the brand-specific gate
    // doesn't fire (q="lupron" !== b="lupron depot") and the LLM's earlier
    // NDA wins.
    mock.on("/drug/drugsfda.json", {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "NDA019732",
          sponsor_name: "ABBVIE",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "19890126",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "LUPRON DEPOT" },
          ],
          openfda: {
            // Two distinct brand strings on the same NDA — that's what
            // lets strong-match accept "Lupron" while we still display
            // "LUPRON DEPOT" as the pipeline brand.
            brand_name: ["LUPRON", "LUPRON DEPOT"],
            generic_name: ["LEUPROLIDE ACETATE"],
            substance_name: ["LEUPROLIDE ACETATE"],
          },
        },
      ],
    });
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "high",
        application_number: "NDA018732",
        application_type: "NDA",
        approval_date: "1985-04-23",
        brand_name: "Lupron",
        generic_name: "leuprolide acetate",
        rationale: "Original immediate-release Lupron predates depot.",
      })
    );
    mock.install();

    const r = await lookupDrug("Lupron", OPTS);

    expect(r.applicationNumber).toBe("NDA018732");
    expect(r.approvalDate).toBe("1985-04-23");
    expect(r.pipelineApplicationNumber).toBe("NDA019732");
  });

  it("uses LLM as last-resort fallback when no pipeline candidate exists", async () => {
    // Aliqopa-style: openFDA has nothing, all six layers come up empty.
    // The LLM is the only source of an answer. High-confidence answers
    // pass; low-confidence ones don't.
    stubAllEmpty(mock);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "unknown",
        status: "approved",
        confidence: "high",
        application_number: "NDA209936",
        application_type: "NDA",
        approval_date: "2017-09-14",
        brand_name: "Aliqopa",
        generic_name: "copanlisib",
        rationale: "Discontinued but originally FDA-approved.",
      })
    );
    mock.install();

    const r = await lookupDrug("Aliqopa", OPTS);

    expect(r.status).toBe("approved");
    expect(r.resolvedVia).toBe("llm");
    expect(r.applicationNumber).toBe("NDA209936");
    expect(r.approvalDate).toBe("2017-09-14");
  });

  it("does not consult the LLM when NDC layer returns otc_monograph", async () => {
    // Tylenol-style: NDC is authoritative for the OTC monograph path. The
    // LLM has a known failure mode where it confidently fabricates an NDA
    // for OTC drugs ("acetaminophen NDA 008783 from 1955"), so the
    // resolver must short-circuit before invoking it.
    mock.on("/drug/drugsfda.json", EMPTY_FDA);
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", {
      meta: { results: { total: 1 } },
      results: [
        {
          product_ndc: "50580-449",
          brand_name: "Tylenol",
          generic_name: "Acetaminophen",
          labeler_name: "KENVUE",
          marketing_category: "OTC MONOGRAPH DRUG",
          active_ingredients: [{ name: "ACETAMINOPHEN", strength: "500 mg" }],
        },
      ],
    });
    mock.install();

    const r = await lookupDrug("Tylenol", OPTS);

    expect(r.status).toBe("otc_monograph");
    expect(r.applicationNumber).toBeUndefined();
    // No call to /api/llm-lookup at all.
    const calls = mock.calledUrls();
    expect(calls.some((u) => u.includes("/api/llm-lookup"))).toBe(false);
  });

  it("rejects override when LLM agreement is 'confirm' (no swap, audit only)", async () => {
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "BLA125514",
        date: "20140904",
        brand: "KEYTRUDA",
        generic: "PEMBROLIZUMAB",
      })
    );
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "confirm",
        status: "approved",
        confidence: "high",
        application_number: "BLA125514",
        approval_date: "2014-09-04",
        brand_name: "KEYTRUDA",
        generic_name: "pembrolizumab",
        rationale: "openFDA's candidate is the original.",
      })
    );
    mock.install();

    const r = await lookupDrug("Keytruda", OPTS);

    expect(r.applicationNumber).toBe("BLA125514");
    expect(r.resolvedVia).toBe("openfda_brand");
    expect(r.llmAgreement).toBe("confirm");
    expect(r.pipelineApplicationNumber).toBeUndefined();
  });

  it("rejects override when same-year date gap < 1 calendar year", async () => {
    // Pipeline date 2017-08-17, LLM proposed 2017-01-15. Same year — the
    // arbiter rejects to avoid bouncing on noise even though strictly the
    // proposed date is earlier.
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "NDA999999",
        date: "20170817",
        brand: "FAKEDRUG",
        generic: "fakegen",
      })
    );
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "high",
        application_number: "NDA888888",
        approval_date: "2017-01-15",
        brand_name: "FAKEDRUG",
        generic_name: "fakegen",
        rationale: "Earlier by 7 months — within noise window.",
      })
    );
    mock.install();

    const r = await lookupDrug("FAKEDRUG", OPTS);

    expect(r.applicationNumber).toBe("NDA999999");
    expect(r.approvalDate).toBe("2017-08-17");
  });

  it("rejects override when LLM confidence is medium", async () => {
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "ANDA999999",
        date: "20100101",
        brand: "DRUGX",
        generic: "drugx",
      })
    );
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "medium",
        application_number: "NDA000001",
        approval_date: "1990-01-01",
        brand_name: "DRUGX",
        generic_name: "drugx",
        rationale: "I think but not sure.",
      })
    );
    mock.install();

    const r = await lookupDrug("DRUGX", OPTS);

    expect(r.applicationNumber).toBe("ANDA999999");
    expect(r.approvalDate).toBe("2010-01-01");
  });

  it("rejects override when LLM proposes a different molecule", async () => {
    // The arbiter checks sameMolecule — if the LLM's generic_name doesn't
    // line up with the pipeline's (even with salt-form forgiveness), the
    // override is rejected to prevent cross-molecule contamination.
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "NDA111111",
        date: "20100101",
        brand: "BRAND",
        generic: "moleculea",
      })
    );
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "high",
        application_number: "NDA000002",
        approval_date: "1980-01-01",
        brand_name: "BRAND",
        generic_name: "different_molecule",
        rationale: "Earlier approval but different active ingredient.",
      })
    );
    mock.install();

    const r = await lookupDrug("BRAND", OPTS);

    expect(r.applicationNumber).toBe("NDA111111");
    expect(r.approvalDate).toBe("2010-01-01");
  });
});

describe("queryOpenFdaDrugsFda — brand/generic merge (regression #13)", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns Xeloda NDA from generic-search results when brand-search only has ANDAs (Capecitabine)", async () => {
    // Pre-fix: brand search for "capecitabine" returned only ANDAs (whose
    // brand_name *is* "CAPECITABINE"), pipeline short-circuited at
    // ANDA091649 2013-09-16. The generic-search would have found Xeloda
    // NDA020896 1998-04-30 but never ran. Post-fix: both searches run and
    // the NDA wins on the merged candidate ranking.
    mock.on(/openfda\.brand_name:"capecitabine"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "ANDA091649",
          sponsor_name: "GENERIC INC",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20130916",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "CAPECITABINE" },
          ],
          openfda: {
            brand_name: ["CAPECITABINE"],
            generic_name: ["CAPECITABINE"],
            substance_name: ["CAPECITABINE"],
          },
        },
      ],
    });
    mock.on(/openfda\.generic_name:"capecitabine"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "NDA020896",
          sponsor_name: "ROCHE",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "19980430",
            },
          ],
          products: [
            { marketing_status: "Discontinued", brand_name: "XELODA" },
          ],
          openfda: {
            brand_name: ["XELODA"],
            generic_name: ["CAPECITABINE"],
            substance_name: ["CAPECITABINE"],
          },
        },
      ],
    });
    mock.install();

    const r = await lookupDrug("Capecitabine", {
      ...OPTS,
      enableLlmProxy: false,
    });

    expect(r.applicationNumber).toBe("NDA020896");
    expect(r.approvalDate).toBe("1998-04-30");
    expect(r.brandName).toBe("XELODA");
    // Post-#33: Xeloda's products are Discontinued but an approved sibling
    // ANDA exists for the same molecule (CAPECITABINE branded as itself).
    // The molecule is still on the market — status promotes to "approved"
    // while keeping the NDA's identity for the original-approval record.
    expect(r.status).toBe("approved");
  });

  it("promotes status to approved when winning NDA's products are discontinued but a sibling ANDA is active (cross-query, #33 duloxetine)", async () => {
    // Brand search returns an approved generic ANDA; generic search
    // returns the original NDA but with all products Discontinued. The
    // merged winner is the NDA (higher rank) — but the molecule is still
    // approved because the sibling ANDA is active.
    mock.on(/openfda\.brand_name:"duloxetine"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "ANDA090778",
          sponsor_name: "TORRENT PHARMS LTD",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20131211",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "DULOXETINE" },
          ],
          openfda: {
            brand_name: ["DULOXETINE"],
            generic_name: ["DULOXETINE HYDROCHLORIDE"],
            substance_name: ["DULOXETINE HYDROCHLORIDE"],
          },
        },
      ],
    });
    mock.on(/openfda\.generic_name:"duloxetine"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "NDA021427",
          sponsor_name: "LILLY",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20040803",
            },
          ],
          products: [
            { marketing_status: "Discontinued", brand_name: "CYMBALTA" },
          ],
          openfda: {
            brand_name: ["CYMBALTA"],
            generic_name: ["DULOXETINE HYDROCHLORIDE"],
            substance_name: ["DULOXETINE HYDROCHLORIDE"],
          },
        },
      ],
    });
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.install();

    const r = await lookupDrug("duloxetine", {
      ...OPTS,
      enableLlmProxy: false,
    });

    expect(r.applicationNumber).toBe("NDA021427");
    expect(r.approvalDate).toBe("2004-08-03");
    expect(r.brandName).toBe("CYMBALTA");
    expect(r.status).toBe("approved");
  });

  it("promotes status to approved when winning NDA is discontinued but a sibling ANDA in the same query is active (within-query, #33)", async () => {
    // Both NDA (discontinued) and ANDA (approved) hit the same generic-
    // name query. NDA wins on rank — without the within-query fix, status
    // would be reported as discontinued.
    mock.on(/openfda\.brand_name:"foodrug"/, EMPTY_FDA);
    mock.on(/openfda\.generic_name:"foodrug"/, {
      meta: { results: { total: 2 } },
      results: [
        {
          application_number: "NDA111111",
          sponsor_name: "ORIGINATOR INC",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20000101",
            },
          ],
          products: [
            { marketing_status: "Discontinued", brand_name: "FOOBRAND" },
          ],
          openfda: {
            brand_name: ["FOOBRAND"],
            generic_name: ["FOODRUG"],
            substance_name: ["FOODRUG"],
          },
        },
        {
          application_number: "ANDA222222",
          sponsor_name: "GENERIC INC",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20150101",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "FOODRUG" },
          ],
          openfda: {
            brand_name: ["FOODRUG"],
            generic_name: ["FOODRUG"],
            substance_name: ["FOODRUG"],
          },
        },
      ],
    });
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.install();

    const r = await lookupDrug("foodrug", {
      ...OPTS,
      enableLlmProxy: false,
    });

    expect(r.applicationNumber).toBe("NDA111111");
    expect(r.approvalDate).toBe("2000-01-01");
    expect(r.status).toBe("approved");
  });

  it("does NOT promote cross-query when winner and loser are different molecules (post-#36 review)", async () => {
    // Pathological case: brand search and generic search happen to
    // resolve to candidates with different generic names. The promotion
    // logic must not flip status just because the loser is approved —
    // we'd be claiming "molecule X is still on the market" using
    // molecule Y's approval as evidence.
    mock.on(/openfda\.brand_name:"oddquery"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "ANDA111111",
          sponsor_name: "GENERIC INC",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20150101",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "ODDQUERY" },
          ],
          openfda: {
            brand_name: ["ODDQUERY"],
            generic_name: ["UNRELATED ALPHA"],
            substance_name: ["UNRELATED ALPHA"],
          },
        },
      ],
    });
    mock.on(/openfda\.generic_name:"oddquery"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "NDA222222",
          sponsor_name: "ORIGINATOR INC",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20000101",
            },
          ],
          products: [
            { marketing_status: "Discontinued", brand_name: "ODDQUERY" },
          ],
          openfda: {
            brand_name: ["ODDQUERY"],
            generic_name: ["UNRELATED BETA"],
            substance_name: ["UNRELATED BETA"],
          },
        },
      ],
    });
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.install();

    const r = await lookupDrug("oddquery", {
      ...OPTS,
      enableLlmProxy: false,
    });

    expect(r.applicationNumber).toBe("NDA222222");
    // Different molecules → no cross-query promotion. Status stays as
    // the winning candidate's actual status (discontinued).
    expect(r.status).toBe("discontinued");
  });

  it("keeps status discontinued when NO sibling application is approved (no false promotion)", async () => {
    // Only the discontinued NDA exists. No sibling — status stays
    // discontinued. (Guards against an over-eager promotion that would
    // mark obsolete molecules as approved.)
    mock.on(/openfda\.brand_name:"obsolete"/, EMPTY_FDA);
    mock.on(/openfda\.generic_name:"obsolete"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "NDA999999",
          sponsor_name: "WITHDRAWN INC",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "19800101",
            },
          ],
          products: [
            { marketing_status: "Discontinued", brand_name: "OBSOLETE" },
          ],
          openfda: {
            brand_name: ["OBSOLETE"],
            generic_name: ["OBSOLETE"],
            substance_name: ["OBSOLETE"],
          },
        },
      ],
    });
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.install();

    const r = await lookupDrug("obsolete", {
      ...OPTS,
      enableLlmProxy: false,
    });

    expect(r.status).toBe("discontinued");
  });
});

describe("lookupDrug — label-text grounding for arbiter (#21)", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plumbs label indications_and_usage into the LLM proxy body and DrugResult", async () => {
    // Pipeline resolves to KEYTRUDA. The appnum-based label fetch returns a
    // canned indication block. We assert the text reaches the proxy POST
    // body and lands on DrugResult.labelIndicationText.
    const INDICATION =
      "KEYTRUDA is indicated for the treatment of patients with unresectable " +
      "or metastatic melanoma.";

    mock.on(
      /openfda\.brand_name:"pembrolizumab"/,
      drugsfdaApproved({
        appNum: "BLA125514",
        date: "20140904",
        brand: "KEYTRUDA",
        generic: "PEMBROLIZUMAB",
      })
    );
    mock.on(/openfda\.generic_name:"pembrolizumab"/, EMPTY_FDA);
    // Layer-2 label lookup by brand name — empty (drugsfda already matched).
    mock.on(/openfda\.brand_name:"pembrolizumab".*label/, EMPTY_LABEL);
    // The new appnum-based label fetch (must match the resolved BLA125514).
    mock.on(/openfda\.application_number:"BLA125514"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["BLA125514"] },
          indications_and_usage: [INDICATION],
        },
      ],
    });
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "confirm",
        status: "approved",
        confidence: "high",
        application_number: "BLA125514",
        application_type: "BLA",
        approval_date: "2014-09-04",
        brand_name: "Keytruda",
        generic_name: "pembrolizumab",
        rationale: "Label text matches the candidate.",
      })
    );
    mock.install();

    const r = await lookupDrug("pembrolizumab", OPTS);

    expect(r.status).toBe("approved");
    expect(r.labelIndicationText).toBeDefined();
    expect(r.labelIndicationText).toContain("unresectable or metastatic melanoma");

    // The LLM proxy must have received the label text as part of the
    // pipelineFinding payload — this is the grounding signal Stage 1 adds.
    const proxyBody = mock.bodyOf("/api/llm-lookup") as {
      pipelineFinding?: { labelIndicationText?: string };
    };
    expect(proxyBody.pipelineFinding?.labelIndicationText).toContain(
      "unresectable or metastatic melanoma"
    );
  });

  it("skips label fetch entirely when no application number was resolved", async () => {
    // Nothing in any layer; pipeline finishes as not_found. Arbiter still
    // runs (proxy enabled, status != otc) but with no pipelineFinding —
    // and crucially, no appnum-based label fetch happens.
    mock.on("/drug/drugsfda.json", EMPTY_FDA);
    mock.on("/drug/label.json", EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on("rxnav.nlm.nih.gov", EMPTY_RXNORM);
    mock.on("ebi.ac.uk/chembl", EMPTY_CHEMBL);
    mock.on("clinicaltrials.gov", EMPTY_CT);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "unknown",
        status: "not_found",
        confidence: "low",
        rationale: "No data.",
      })
    );
    mock.install();

    const r = await lookupDrug("notadrug", OPTS);

    expect(r.labelIndicationText).toBeUndefined();
    // No call should have hit the appnum-search path.
    const sawAppnumFetch = mock
      .calledUrls()
      .some((u) => /openfda\.application_number/.test(decodeURIComponent(u)));
    expect(sawAppnumFetch).toBe(false);
  });

  it("populates currentIndications + originalIndication from the LLM response (#22)", async () => {
    mock.on(
      /openfda\.brand_name:"pembrolizumab"/,
      drugsfdaApproved({
        appNum: "BLA125514",
        date: "20140904",
        brand: "KEYTRUDA",
        generic: "PEMBROLIZUMAB",
      })
    );
    mock.on(/openfda\.generic_name:"pembrolizumab"/, EMPTY_FDA);
    mock.on(/label\.json/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["BLA125514"] },
          indications_and_usage: [
            "KEYTRUDA is indicated for the treatment of melanoma, NSCLC, " +
              "HNSCC, and several other tumor types.",
          ],
        },
      ],
    });
    mock.on(/ndc\.json/, EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "confirm",
        status: "approved",
        confidence: "high",
        application_number: "BLA125514",
        application_type: "BLA",
        approval_date: "2014-09-04",
        brand_name: "KEYTRUDA",
        generic_name: "pembrolizumab",
        current_indications: [
          "unresectable or metastatic melanoma",
          "metastatic non-small cell lung cancer",
          "recurrent or metastatic head and neck squamous cell carcinoma",
        ],
        original_indication: "unresectable or metastatic melanoma",
        rationale: "Label matches.",
      })
    );
    mock.install();

    const r = await lookupDrug("pembrolizumab", OPTS);

    expect(r.currentIndications).toEqual([
      "unresectable or metastatic melanoma",
      "metastatic non-small cell lung cancer",
      "recurrent or metastatic head and neck squamous cell carcinoma",
    ]);
    expect(r.originalIndication).toBe("unresectable or metastatic melanoma");
  });

  it("drops empty/whitespace-only indication strings from the LLM response (#22)", async () => {
    mock.on(
      /openfda\.brand_name:"pembrolizumab"/,
      drugsfdaApproved({
        appNum: "BLA125514",
        date: "20140904",
        brand: "KEYTRUDA",
        generic: "PEMBROLIZUMAB",
      })
    );
    mock.on(/openfda\.generic_name:"pembrolizumab"/, EMPTY_FDA);
    mock.on(/label\.json/, EMPTY_LABEL);
    mock.on(/ndc\.json/, EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "confirm",
        status: "approved",
        confidence: "high",
        current_indications: ["  ", "", "  melanoma  "],
        original_indication: "   ",
      })
    );
    mock.install();

    const r = await lookupDrug("pembrolizumab", OPTS);

    expect(r.currentIndications).toEqual(["melanoma"]);
    expect(r.originalIndication).toBeUndefined();
  });

  it("keeps pipeline-sourced indications when arbiter overrides to an app missing from openFDA (#21/#22/#45)", async () => {
    // The label text we fetched belongs to the rejected pipeline app. We try
    // to refetch for the LLM-proposed app; when that misses (the typical
    // case — the corrected NDA pre-dates openFDA's online window), we keep
    // the pipeline's text and bullets. shouldOverride already gated on
    // same-molecule, so the indications are valid for the resolved drug.
    // We track that provenance in indicationApplicationNumber.
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "ANDA071868",
        date: "19900604",
        brand: "CYTARABINE",
        generic: "CYTARABINE",
      })
    );
    mock.on(/openfda\.application_number:"ANDA071868"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["ANDA071868"] },
          marketing_category: "ANDA",
          indications_and_usage: [
            "Cytarabine is indicated for acute non-lymphocytic leukemia.",
          ],
        },
      ],
    });
    // No label exists for the LLM-proposed app (the imatinib NDA021335 /
    // Cytosar-U NDA016406 case): refetch returns empty.
    mock.on(/openfda\.application_number:"NDA016406"/, EMPTY_LABEL);
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "high",
        application_number: "NDA016406",
        application_type: "NDA",
        approval_date: "1969-06-24",
        brand_name: "Cytosar-U",
        generic_name: "cytarabine",
        current_indications: [
          "acute non-lymphocytic leukemia",
        ],
        original_indication: "acute leukemia",
        rationale: "Original Cytosar-U NDA predates openFDA's online window.",
      })
    );
    mock.install();

    const r = await lookupDrug("Cytarabine", OPTS);

    expect(r.resolvedVia).toBe("llm");
    expect(r.applicationNumber).toBe("NDA016406");
    expect(r.pipelineApplicationNumber).toBe("ANDA071868");
    // Pipeline-sourced text/bullets are retained for the user; provenance
    // is captured in indicationApplicationNumber so the UI can annotate.
    expect(r.labelIndicationText).toContain("acute non-lymphocytic leukemia");
    expect(r.currentIndications).toEqual(["acute non-lymphocytic leukemia"]);
    expect(r.indicationApplicationNumber).toBe("ANDA071868");
    expect(r.originalIndication).toBe("acute leukemia");
  });

  it("replaces indications with LLM-proposed app's label when the refetch hits (#45)", async () => {
    // When the override target *does* have an openFDA label, swap to that
    // label so indications attach to the resolved application. The arbiter's
    // bullets (extracted from the rejected label) are dropped — they don't
    // necessarily match the new text.
    mock.on(
      "/drug/drugsfda.json",
      drugsfdaApproved({
        appNum: "ANDA071868",
        date: "19900604",
        brand: "CYTARABINE",
        generic: "CYTARABINE",
      })
    );
    mock.on(/openfda\.application_number:"ANDA071868"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["ANDA071868"] },
          marketing_category: "ANDA",
          indications_and_usage: [
            "Cytarabine is indicated for acute non-lymphocytic leukemia.",
          ],
        },
      ],
    });
    mock.on(/openfda\.application_number:"NDA016406"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["NDA016406"] },
          marketing_category: "NDA",
          indications_and_usage: [
            "Cytosar-U is indicated in the treatment of acute leukemia.",
          ],
        },
      ],
    });
    mock.on("/drug/ndc.json", EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "correct",
        status: "approved",
        confidence: "high",
        application_number: "NDA016406",
        application_type: "NDA",
        approval_date: "1969-06-24",
        brand_name: "Cytosar-U",
        generic_name: "cytarabine",
        current_indications: [
          "acute non-lymphocytic leukemia",
        ],
        rationale: "Cytosar-U is the original Cytarabine approval.",
      })
    );
    mock.install();

    const r = await lookupDrug("Cytarabine", OPTS);

    expect(r.resolvedVia).toBe("llm");
    expect(r.applicationNumber).toBe("NDA016406");
    expect(r.labelIndicationText).toContain("treatment of acute leukemia");
    expect(r.indicationApplicationNumber).toBe("NDA016406");
    // Bullets came from the rejected ANDA's label — drop them.
    expect(r.currentIndications).toBeUndefined();
  });

  it("preserves labelIndicationText + currentIndications when arbiter confirms (no override)", async () => {
    mock.on(
      /openfda\.brand_name:"pembrolizumab"/,
      drugsfdaApproved({
        appNum: "BLA125514",
        date: "20140904",
        brand: "KEYTRUDA",
        generic: "PEMBROLIZUMAB",
      })
    );
    mock.on(/openfda\.generic_name:"pembrolizumab"/, EMPTY_FDA);
    mock.on(/openfda\.application_number:"BLA125514"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["BLA125514"] },
          indications_and_usage: ["Keytruda is indicated for melanoma."],
        },
      ],
    });
    mock.on(/ndc\.json/, EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "confirm",
        status: "approved",
        confidence: "high",
        application_number: "BLA125514",
        application_type: "BLA",
        approval_date: "2014-09-04",
        current_indications: ["unresectable or metastatic melanoma"],
        rationale: "Label matches.",
      })
    );
    mock.install();

    const r = await lookupDrug("pembrolizumab", OPTS);

    expect(r.resolvedVia).toBe("openfda_brand");
    expect(r.applicationNumber).toBe("BLA125514");
    expect(r.labelIndicationText).toContain("melanoma");
    expect(r.currentIndications).toEqual([
      "unresectable or metastatic melanoma",
    ]);
    expect(r.indicationApplicationNumber).toBe("BLA125514");
  });

  it("handles null/missing indications fields gracefully (#22 — fixtures from #18 still pass)", async () => {
    mock.on(
      /openfda\.brand_name:"pembrolizumab"/,
      drugsfdaApproved({
        appNum: "BLA125514",
        date: "20140904",
        brand: "KEYTRUDA",
        generic: "PEMBROLIZUMAB",
      })
    );
    mock.on(/openfda\.generic_name:"pembrolizumab"/, EMPTY_FDA);
    mock.on(/label\.json/, EMPTY_LABEL);
    mock.on(/ndc\.json/, EMPTY_NDC);
    mock.on(
      "/api/llm-lookup",
      llmPayload({
        agreement: "confirm",
        status: "approved",
        confidence: "high",
        // current_indications and original_indication intentionally absent
      })
    );
    mock.install();

    const r = await lookupDrug("pembrolizumab", OPTS);

    expect(r.currentIndications).toBeUndefined();
    expect(r.originalIndication).toBeUndefined();
    expect(r.status).toBe("approved");
  });

  it("does not fetch label or invoke arbiter when status is otc_monograph", async () => {
    // Aspirin: NDC resolves to OTC monograph, arbiter is skipped per the
    // existing rule, so the new label-grounding fetch must also be skipped.
    mock.on(/drugsfda\.json/, EMPTY_FDA);
    mock.on(/label\.json/, EMPTY_LABEL);
    mock.on(/ndc\.json.*brand_name:"aspirin"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          brand_name: "Aspirin",
          generic_name: "Aspirin",
          labeler_name: "GENERIC OTC",
          marketing_category: "OTC MONOGRAPH DRUG",
          active_ingredients: [{ name: "ASPIRIN" }],
        },
      ],
    });
    mock.on(/ndc\.json/, EMPTY_NDC);
    mock.install();

    const r = await lookupDrug("aspirin", OPTS);

    expect(r.status).toBe("otc_monograph");
    expect(r.labelIndicationText).toBeUndefined();
    // No proxy call, no appnum fetch.
    expect(mock.calledUrls().some((u) => u.includes("/api/llm-lookup"))).toBe(
      false
    );
  });
});

describe("sameMolecule (arbiter override gate, #31)", () => {
  // Table-driven so the legitimate salt-form / biosimilar matches and
  // the previously-permissive false positives are pinned side by side.
  const CASES: Array<[string, string | undefined, string | undefined, boolean]> = [
    // Salt-form variants — should match (legitimate use of the gate).
    ["base ↔ salt forward", "tamoxifen", "tamoxifen citrate", true],
    ["base ↔ salt reverse", "doxorubicin hydrochloride", "doxorubicin", true],
    ["exact case-insensitive", "PEMBROLIZUMAB", "pembrolizumab", true],
    [
      "biosimilar suffix tokenizes separately",
      "pembrolizumab",
      "pembrolizumab-aaaa",
      true,
    ],
    // Multi-token salt tail (post-#36 Copilot review) — openFDA does
    // emit forms like "doxorubicin hydrochloride monohydrate".
    [
      "salt + hydrate suffix",
      "doxorubicin",
      "doxorubicin hydrochloride monohydrate",
      true,
    ],
    [
      "salt + hemihydrate suffix",
      "pamidronate",
      "pamidronate disodium hemihydrate",
      false, // disodium isn't in the salt list — guards against accidental over-acceptance
    ],
    // Substring-overlap false positives that the old `includes` clauses
    // accepted — must now reject.
    ["iron ≠ iron sucrose", "iron", "iron sucrose", false],
    ["iron sucrose ≠ iron dextran", "iron sucrose", "iron dextran", false],
    ["acid ≠ folic acid", "acid", "folic acid", false],
    [
      "furosemide ≠ furosemide and amiloride",
      "furosemide",
      "furosemide and amiloride",
      false,
    ],
    // Edge case not asserted: "sodium" vs "sodium chloride" — the
    // salt-suffix list contains both "sodium" and "chloride", so the
    // current check accepts this. Not worth fixing: neither the pipeline
    // nor the arbiter would propose "sodium" as a drug candidate.
    // No-data fallback: undefined inputs can't be disproven, so allow.
    ["both undefined → allow", undefined, undefined, true],
    ["one undefined → allow", "tamoxifen", undefined, true],
  ];

  for (const [label, a, b, expected] of CASES) {
    it(label, () => {
      expect(sameMolecule(a, b)).toBe(expected);
    });
  }
});
