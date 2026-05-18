import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchMock } from "./test/fetchMock";
import { lookupDrug } from "./lookup";

// Layer 7 (Gemini via /api/llm-lookup) integration tests. These pin down the
// arbiter behavior from issue #13 — strict brand-equality gating, generic-
// name precedence, override thresholds — using mocked fetches against the
// same FetchMock infrastructure the rest of the resolver tests use.

const OPTS = {
  apiKey: "",
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
    expect(r.status).toBe("discontinued");
  });
});
