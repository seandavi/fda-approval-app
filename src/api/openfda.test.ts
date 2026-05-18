import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { FetchMock } from "../test/fetchMock";
import {
  fetchLabelIndicationByAppNum,
  queryOpenFdaDrugsFda,
} from "./openfda";

const FLUOROURACIL_BRAND_FIXTURE = {
  meta: { results: { total: 5 } },
  results: [
    // First in the array is a 2021 ANDA — pre-fix this was returned.
    {
      application_number: "ANDA214845",
      sponsor_name: "GENERIC A INC",
      submissions: [
        { submission_type: "ORIG", submission_status: "AP", submission_status_date: "20211007" },
      ],
      products: [{ marketing_status: "Prescription", brand_name: "FLUOROURACIL" }],
      openfda: {
        brand_name: ["FLUOROURACIL"],
        generic_name: ["FLUOROURACIL"],
        substance_name: ["FLUOROURACIL"],
      },
    },
    // Buried in the result set is the original 1962 NDA. The fix should
    // prefer this over the ANDA.
    {
      application_number: "NDA012209",
      sponsor_name: "ROCHE",
      submissions: [
        { submission_type: "ORIG", submission_status: "AP", submission_status_date: "19620731" },
      ],
      products: [{ marketing_status: "Prescription", brand_name: "ADRUCIL" }],
      openfda: {
        brand_name: ["ADRUCIL"],
        generic_name: ["FLUOROURACIL"],
        substance_name: ["FLUOROURACIL"],
      },
    },
  ],
};

const MECBOTAMAB_WRONG_WILDCARD_FIXTURE = {
  // Pre-fix: drugsfda wildcard `mecbotamab vedotin*` returned -vedotin drugs
  // (Polivy, Padcev, Adcetris) — none of which is actually mecbotamab. None
  // pass isStrongDrugsFdaMatch, so we expect no approval. The fixture below
  // is what the broken query used to return.
  meta: { results: { total: 5 } },
  results: [
    {
      application_number: "BLA125388",
      sponsor_name: "SEAGEN",
      submissions: [
        { submission_type: "ORIG", submission_status: "AP", submission_status_date: "20110819" },
      ],
      products: [{ marketing_status: "Prescription", brand_name: "ADCETRIS" }],
      openfda: {
        brand_name: ["ADCETRIS"],
        generic_name: ["BRENTUXIMAB VEDOTIN"],
        substance_name: ["BRENTUXIMAB VEDOTIN"],
      },
    },
  ],
};

describe("queryOpenFdaDrugsFda", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers original NDA over recent ANDA for fluorouracil (regression: 5FU date)", async () => {
    mock.on("/drug/drugsfda.json", FLUOROURACIL_BRAND_FIXTURE);
    mock.install();

    const result = await queryOpenFdaDrugsFda("fluorouracil", "");

    expect(result.status).toBe("approved");
    expect(result.applicationNumber).toBe("NDA012209");
    expect(result.applicationType).toBe("NDA");
    expect(result.approvalDate).toBe("1962-07-31");
  });

  it("does not falsely resolve a multi-word INN with no FDA approval (regression: BA3011 → Adcetris)", async () => {
    // Pre-fix, the wildcard pass on a multi-token query like
    // "mecbotamab vedotin" would hit Adcetris/Polivy/etc. After fix, we only
    // do a phrase-quoted search, which legitimately returns nothing for a
    // non-existent INN. Even if openFDA *did* return Adcetris, the
    // strong-match filter must keep it out.
    mock.on(/openfda\.brand_name:"mecbotamab vedotin"/, {
      meta: { results: { total: 0 } },
      results: [],
    });
    mock.on(/openfda\.generic_name:"mecbotamab vedotin"/, {
      meta: { results: { total: 0 } },
      results: [],
    });
    // Hostile fallback: in case any unexpected URL is built, we serve the
    // Adcetris fixture and assert the strong-match filter rejects it.
    mock.on("/drug/drugsfda.json", MECBOTAMAB_WRONG_WILDCARD_FIXTURE);
    mock.install();

    const result = await queryOpenFdaDrugsFda("mecbotamab vedotin", "");

    expect(result.status).toBeUndefined();
    expect(result.brandName).toBeUndefined();
  });

  it("does not append wildcard `*` to multi-token names (regression: openFDA tokenization)", async () => {
    mock.on("/drug/drugsfda.json", { meta: { results: { total: 0 } }, results: [] });
    mock.install();

    await queryOpenFdaDrugsFda("mecbotamab vedotin", "");

    for (const url of mock.calledUrls()) {
      // No `mecbotamab vedotin*` raw query — must be phrase-quoted.
      expect(url).not.toMatch(/brand_name:[^"]*vedotin\*/);
      expect(url).not.toMatch(/generic_name:[^"]*vedotin\*/);
    }
  });

  it("resolves combo product with distinct brand name (regression #13: Rybrevant Faspro)", async () => {
    // RYBREVANT FASPRO has two ingredients (amivantamab + hyaluronidase).
    // Pre-fix, isStrongDrugsFdaMatch's `substances.length <= 1` clause
    // rejected the result, so the layer returned not_found.
    mock.on("/drug/drugsfda.json", {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "BLA761433",
          sponsor_name: "JANSSEN BIOTECH",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20251217",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "RYBREVANT FASPRO" },
          ],
          openfda: {
            brand_name: ["RYBREVANT FASPRO"],
            generic_name: [
              "AMIVANTAMAB AND HYALURONIDASE-LPUJ (HUMAN RECOMBINANT)",
            ],
            substance_name: [
              "AMIVANTAMAB",
              "HYALURONIDASE (HUMAN RECOMBINANT)",
            ],
          },
        },
      ],
    });
    mock.install();

    const result = await queryOpenFdaDrugsFda("Rybrevant Faspro", "");

    expect(result.status).toBe("approved");
    expect(result.applicationNumber).toBe("BLA761433");
    expect(result.brandName).toBe("RYBREVANT FASPRO");
    expect(result.approvalDate).toBe("2025-12-17");
  });

  it("resolves base INN against salt-form generic (regression #13: tamoxifen → TAMOXIFEN CITRATE)", async () => {
    // Pre-fix, "tamoxifen" didn't match a single-ingredient result whose
    // substance_name was "TAMOXIFEN CITRATE" because the exact-equality check
    // failed. Salt-form matching now bridges base INN ↔ salt variant.
    mock.on("/drug/drugsfda.json", {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "NDA021807",
          sponsor_name: "MAYNE PHARMA COMMRCL",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20051029",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "SOLTAMOX" },
          ],
          openfda: {
            brand_name: ["SOLTAMOX"],
            generic_name: ["TAMOXIFEN CITRATE"],
            substance_name: ["TAMOXIFEN CITRATE"],
          },
        },
      ],
    });
    mock.install();

    const result = await queryOpenFdaDrugsFda("tamoxifen", "");

    expect(result.status).toBe("approved");
    expect(result.applicationNumber).toBe("NDA021807");
  });

  it("still rejects combo products whose brand_name doesn't match the query (regression #6: aspirin → Aggrenox)", async () => {
    // The brand-name exact-match relaxation must not regress #6 — a query
    // for "aspirin" against an Aggrenox-shaped record still has no exact
    // brand-name match and 2 substances, so it should be filtered out.
    mock.on("/drug/drugsfda.json", {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "NDA021521",
          sponsor_name: "BOEHRINGER INGELHEIM",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "19991123",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "AGGRENOX" },
          ],
          openfda: {
            brand_name: ["AGGRENOX"],
            generic_name: ["ASPIRIN AND EXTENDED-RELEASE DIPYRIDAMOLE"],
            substance_name: ["ASPIRIN", "DIPYRIDAMOLE"],
          },
        },
      ],
    });
    mock.install();

    const result = await queryOpenFdaDrugsFda("aspirin", "");

    expect(result.status).toBeUndefined();
  });
});

describe("fetchLabelIndicationByAppNum", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns indication text when openFDA has a current label for the appnum", async () => {
    mock.on(/openfda\.application_number:"BLA125514"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: {
            application_number: ["BLA125514"],
            brand_name: ["KEYTRUDA"],
            generic_name: ["PEMBROLIZUMAB"],
          },
          indications_and_usage: [
            "1 INDICATIONS AND USAGE KEYTRUDA is indicated for the " +
              "treatment of patients with unresectable or metastatic melanoma.",
          ],
        },
      ],
    });
    mock.install();

    const result = await fetchLabelIndicationByAppNum("BLA125514", "");

    expect(result.indicationText).toBeDefined();
    expect(result.indicationText).toContain("unresectable or metastatic melanoma");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].hit).toBe(true);
  });

  it("returns undefined when the label exists but has no indications_and_usage", async () => {
    mock.on(/openfda\.application_number/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["NDA999999"] },
          // no indications_and_usage field
        },
      ],
    });
    mock.install();

    const result = await fetchLabelIndicationByAppNum("NDA999999", "");

    expect(result.indicationText).toBeUndefined();
    expect(result.sources[0].hit).toBe(false);
    expect(result.sources[0].detail).toBe("no indications section");
  });

  it("returns undefined when openFDA has no label for the appnum (404)", async () => {
    mock.notFound(/openfda\.application_number/);
    mock.install();

    const result = await fetchLabelIndicationByAppNum("NDA000000", "");

    expect(result.indicationText).toBeUndefined();
    expect(result.sources[0].hit).toBe(false);
    expect(result.sources[0].detail).toBe("no label");
  });

  it("strips HIGHLIGHTS OF PRESCRIBING INFORMATION boilerplate from the start", async () => {
    const labelText =
      "HIGHLIGHTS OF PRESCRIBING INFORMATION\n" +
      "These highlights do not include all the information needed to use " +
      "KEYTRUDA safely and effectively. See full prescribing information " +
      "for KEYTRUDA. KEYTRUDA injection, for intravenous use Initial U.S. " +
      "Approval: 2014\n" +
      "1 INDICATIONS AND USAGE KEYTRUDA is indicated for the treatment of " +
      "unresectable or metastatic melanoma.";
    mock.on(/openfda\.application_number/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["BLA125514"] },
          indications_and_usage: [labelText],
        },
      ],
    });
    mock.install();

    const result = await fetchLabelIndicationByAppNum("BLA125514", "");

    expect(result.indicationText).toBeDefined();
    expect(result.indicationText).not.toMatch(/HIGHLIGHTS OF PRESCRIBING INFORMATION/);
    expect(result.indicationText).toContain("1 INDICATIONS AND USAGE");
    expect(result.indicationText).toContain("melanoma");
  });

  it("never throws — network errors surface in sources", async () => {
    // No mock route registered → FetchMock returns 500. The function must
    // record the error without throwing.
    mock.install();

    const result = await fetchLabelIndicationByAppNum("NDA123456", "");

    expect(result.indicationText).toBeUndefined();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].hit).toBe(false);
  });

  it("prefers NDA/BLA labels over ANDA labels for the same appnum (multi-SPL records)", async () => {
    // openFDA can return both the original NDA label and a generic ANDA
    // label for the same molecule. The NDA label has the canonical
    // indications and should win even if listed second.
    mock.on(/openfda\.application_number/, {
      meta: { results: { total: 2 } },
      results: [
        {
          openfda: { application_number: ["NDA012209"] },
          marketing_category: "ANDA",
          indications_and_usage: ["ANDA label — minimal indication."],
        },
        {
          openfda: { application_number: ["NDA012209"] },
          marketing_category: "NDA",
          indications_and_usage: [
            "Original NDA label — comprehensive indications across multiple " +
              "cancer types and dosing schedules.",
          ],
        },
      ],
    });
    mock.install();

    const result = await fetchLabelIndicationByAppNum("NDA012209", "");

    expect(result.indicationText).toContain("Original NDA label");
    expect(result.indicationText).not.toContain("ANDA label");
  });

  it("picks the longest indications text within the same marketing category (most-current label)", async () => {
    // Two NDA labels with different revision dates aren't distinguishable
    // by category — pick the one with more text since fully-supplemented
    // labels grow over time.
    mock.on(/openfda\.application_number/, {
      meta: { results: { total: 2 } },
      results: [
        {
          openfda: { application_number: ["BLA125514"] },
          marketing_category: "BLA",
          indications_and_usage: ["Old indication: melanoma."],
        },
        {
          openfda: { application_number: ["BLA125514"] },
          marketing_category: "BLA",
          indications_and_usage: [
            "Current indications: melanoma, NSCLC, HNSCC, classical Hodgkin " +
              "lymphoma, urothelial, MSI-H solid tumors, and more.",
          ],
        },
      ],
    });
    mock.install();

    const result = await fetchLabelIndicationByAppNum("BLA125514", "");

    expect(result.indicationText).toContain("NSCLC");
    expect(result.indicationText).toContain("urothelial");
  });

  it("treats fully-stripped indications as no usable grounding (defensive)", async () => {
    // Synthetic edge case: the entire indications_and_usage is content
    // that the boilerplate stripper removes (just "See full prescribing
    // information…" lines). After stripping, cleaned is empty — must
    // report as no grounding rather than a zero-char "successful" hit.
    mock.on(/openfda\.application_number/, {
      meta: { results: { total: 1 } },
      results: [
        {
          openfda: { application_number: ["NDA000001"] },
          indications_and_usage: [
            "See full prescribing information for FOO. " +
              "See full prescribing information for BAR.",
          ],
        },
      ],
    });
    mock.install();

    const result = await fetchLabelIndicationByAppNum("NDA000001", "");

    expect(result.indicationText).toBeUndefined();
    expect(result.sources[0].hit).toBe(false);
    expect(result.sources[0].detail).toMatch(/stripping boilerplate/);
  });
});
