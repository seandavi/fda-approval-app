import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { FetchMock } from "../test/fetchMock";
import { queryOpenFdaDrugsFda } from "./openfda";

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
});
