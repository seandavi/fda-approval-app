import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchMock } from "./test/fetchMock";
import { lookupDrug } from "./lookup";

const OPTS = {
  enableLlmProxy: false,
  ttlDays: 7,
  useCache: false,
};

const EMPTY_FDA = { meta: { results: { total: 0 } }, results: [] };
const EMPTY_NDC = { meta: { results: { total: 0 } }, results: [] };
const EMPTY_LABEL = { meta: { results: { total: 0 } }, results: [] };
const EMPTY_CT = { studies: [] };
const EMPTY_CHEMBL = { molecules: [] };
const EMPTY_RXNORM = { drugGroup: { conceptGroup: [] } };

describe("lookupDrug — true positives", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pembrolizumab resolves to KEYTRUDA (BLA)", async () => {
    mock.on(/openfda\.brand_name:"pembrolizumab"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "BLA125514",
          sponsor_name: "MERCK",
          submissions: [
            {
              submission_type: "ORIG",
              submission_status: "AP",
              submission_status_date: "20140904",
            },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "KEYTRUDA" },
          ],
          openfda: {
            brand_name: ["KEYTRUDA"],
            generic_name: ["PEMBROLIZUMAB"],
            substance_name: ["PEMBROLIZUMAB"],
          },
        },
      ],
    });
    mock.install();

    const result = await lookupDrug("pembrolizumab", OPTS);

    expect(result.status).toBe("approved");
    expect(result.applicationType).toBe("BLA");
    expect(result.brandName).toBe("KEYTRUDA");
    expect(result.approvalDate).toBe("2014-09-04");
  });

  it("aspirin resolves via NDC as OTC monograph", async () => {
    // drugsfda/label can't strong-match aspirin (everything is a combo).
    mock.on(/drugsfda\.json/, EMPTY_FDA);
    mock.on(/label\.json/, EMPTY_LABEL);
    // NDC has a single-ingredient aspirin OTC monograph product.
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

    const result = await lookupDrug("aspirin", OPTS);

    expect(result.status).toBe("otc_monograph");
    expect(result.resolvedVia).toBe("openfda_ndc");
    expect(result.brandName?.toLowerCase()).toBe("aspirin");
  });

  it("5FU resolves via ChEMBL → fluorouracil and returns the original 1962 NDA date (regression: #9)", async () => {
    // FDA layers don't index "5FU" as a brand/generic — search misses.
    mock.on(/drugsfda\.json.*5FU/, EMPTY_FDA);
    mock.on(/label\.json.*5FU/, EMPTY_LABEL);
    mock.on(/ndc\.json.*5FU/, EMPTY_NDC);
    mock.on(/rxnav\.nlm\.nih\.gov.*5FU/, EMPTY_RXNORM);
    // ChEMBL translates the slang to the INN.
    mock.on(/iexact=5FU/, {
      molecules: [
        {
          pref_name: "FLUOROURACIL",
          molecule_chembl_id: "CHEMBL185",
          molecule_synonyms: [
            { synonyms: "FLUOROURACIL", syn_type: "INN" },
            { synonyms: "5FU", syn_type: "OTHER" },
          ],
        },
      ],
    });
    // Re-run with the INN hits drugsfda. The fixture mirrors what openFDA
    // actually returns: recent ANDAs are listed before the original NDA.
    // Pre-fix the resolver picked the first result (2021 ANDA); the fix
    // ranks by app-type and earliest approval date to pick the 1962 NDA.
    mock.on(/openfda\.brand_name:"fluorouracil"/, {
      meta: { results: { total: 5 } },
      results: [
        {
          application_number: "ANDA214845",
          sponsor_name: "GENERIC A",
          submissions: [
            { submission_status: "AP", submission_status_date: "20211007" },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "FLUOROURACIL" },
          ],
          openfda: {
            brand_name: ["FLUOROURACIL"],
            generic_name: ["FLUOROURACIL"],
            substance_name: ["FLUOROURACIL"],
          },
        },
        {
          application_number: "NDA012209",
          sponsor_name: "ROCHE",
          submissions: [
            { submission_status: "AP", submission_status_date: "19620731" },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "ADRUCIL" },
          ],
          openfda: {
            brand_name: ["ADRUCIL"],
            generic_name: ["FLUOROURACIL"],
            substance_name: ["FLUOROURACIL"],
          },
        },
      ],
    });
    mock.install();

    const result = await lookupDrug("5FU", OPTS);

    expect(result.status).toBe("approved");
    expect(result.applicationNumber).toBe("NDA012209");
    expect(result.applicationType).toBe("NDA");
    expect(result.approvalDate).toBe("1962-07-31");
    expect(result.resolvedINN).toBe("fluorouracil");
  });

  it("MK-3475 (internal ID) resolves to KEYTRUDA via ChEMBL → pembrolizumab", async () => {
    // FDA layers return nothing for the raw internal ID.
    mock.on(/openfda\.brand_name:"MK-3475"/, EMPTY_FDA);
    mock.on(/openfda\.generic_name:"MK-3475"/, EMPTY_FDA);
    mock.on(/openfda\.brand_name:MK-3475\*/, EMPTY_FDA);
    mock.on(/openfda\.generic_name:MK-3475\*/, EMPTY_FDA);
    mock.on(/label\.json.*MK-3475/, EMPTY_LABEL);
    mock.on(/ndc\.json.*MK-3475/, EMPTY_NDC);
    mock.on(/rxnav\.nlm\.nih\.gov/, EMPTY_RXNORM);
    // ChEMBL translates MK-3475 → pembrolizumab.
    mock.on(/iexact=MK-3475/, {
      molecules: [
        {
          pref_name: "PEMBROLIZUMAB",
          molecule_chembl_id: "CHEMBL3137343",
          molecule_synonyms: [
            { synonyms: "PEMBROLIZUMAB", syn_type: "INN" },
            { synonyms: "MK-3475", syn_type: "RESEARCH_CODE" },
          ],
        },
      ],
    });
    // Re-run with INN hits the BLA.
    mock.on(/openfda\.brand_name:"pembrolizumab"/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "BLA125514",
          sponsor_name: "MERCK",
          submissions: [
            { submission_status: "AP", submission_status_date: "20140904" },
          ],
          products: [{ marketing_status: "Prescription", brand_name: "KEYTRUDA" }],
          openfda: {
            brand_name: ["KEYTRUDA"],
            generic_name: ["PEMBROLIZUMAB"],
            substance_name: ["PEMBROLIZUMAB"],
          },
        },
      ],
    });
    mock.install();

    const result = await lookupDrug("MK-3475", OPTS);

    expect(result.status).toBe("approved");
    expect(result.brandName).toBe("KEYTRUDA");
    expect(result.resolvedINN).toBe("pembrolizumab");
  });
});

describe("lookupDrug — true negatives", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gibberish (xyzzz) returns not_found", async () => {
    mock.on(/drugsfda\.json/, EMPTY_FDA);
    mock.on(/label\.json/, EMPTY_LABEL);
    mock.on(/ndc\.json/, EMPTY_NDC);
    mock.on(/rxnav\.nlm\.nih\.gov/, EMPTY_RXNORM);
    mock.on(/ebi\.ac\.uk/, EMPTY_CHEMBL);
    mock.on(/clinicaltrials\.gov/, EMPTY_CT);
    mock.install();

    const result = await lookupDrug("xyzzz", OPTS);

    expect(result.status).toBe("not_found");
    expect(result.brandName).toBeUndefined();
    expect(result.applicationNumber).toBeUndefined();
  });

  it("BA3011 (real but unapproved ADC) returns not_found, does NOT leak Adcetris", async () => {
    // FDA layers have nothing for BA3011 or its INN.
    mock.on(/drugsfda\.json.*BA3011/, EMPTY_FDA);
    mock.on(/drugsfda\.json.*mecbotamab/, EMPTY_FDA);
    mock.on(/label\.json/, EMPTY_LABEL);
    mock.on(/ndc\.json/, EMPTY_NDC);
    mock.on(/rxnav\.nlm\.nih\.gov/, EMPTY_RXNORM);
    // ChEMBL gives the correct INN.
    mock.on(/iexact=BA3011/, {
      molecules: [
        {
          pref_name: "MECBOTAMAB VEDOTIN",
          molecule_chembl_id: "CHEMBL5095312",
          molecule_synonyms: [
            { synonyms: "MECBOTAMAB VEDOTIN", syn_type: "INN" },
            { synonyms: "BA3011", syn_type: "RESEARCH_CODE" },
          ],
        },
      ],
    });
    // Hostile fallback: even if a stale fetch accidentally hit Adcetris,
    // the result should be filtered out. (Pre-fix bug: the wildcard pass
    // on "mecbotamab vedotin*" used to surface Adcetris.)
    mock.on(/drugsfda\.json/, {
      meta: { results: { total: 1 } },
      results: [
        {
          application_number: "BLA125388",
          sponsor_name: "SEAGEN",
          submissions: [
            { submission_status: "AP", submission_status_date: "20110819" },
          ],
          products: [{ marketing_status: "Prescription", brand_name: "ADCETRIS" }],
          openfda: {
            brand_name: ["ADCETRIS"],
            generic_name: ["BRENTUXIMAB VEDOTIN"],
            substance_name: ["BRENTUXIMAB VEDOTIN"],
          },
        },
      ],
    });
    // CT.gov returns the intervention but with no INN-style otherNames.
    mock.on(/clinicaltrials\.gov/, {
      studies: [
        {
          protocolSection: {
            armsInterventionsModule: {
              interventions: [{ name: "BA3011", otherNames: [] }],
            },
          },
        },
      ],
    });
    mock.install();

    const result = await lookupDrug("BA3011", OPTS);

    expect(result.status).toBe("not_found");
    expect(result.brandName).not.toBe("ADCETRIS");
    expect(result.brandName).toBeUndefined();
  });

  it("acetaminophen does NOT pick up combination-product generic names (regression)", async () => {
    // Mimic openFDA returning combos *first* and the single-ingredient
    // ANDA second — strong-match must skip the combos and pick acetaminophen.
    mock.on(/drugsfda\.json/, {
      meta: { results: { total: 2 } },
      results: [
        {
          application_number: "ANDA040387",
          submissions: [
            { submission_status: "AP", submission_status_date: "19850101" },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "FIORICET" },
          ],
          openfda: {
            brand_name: ["BUTALBITAL, ACETAMINOPHEN AND CAFFEINE"],
            generic_name: ["IBUPROFEN"], // intentionally wrong array to assert strong-match
            substance_name: ["ACETAMINOPHEN", "BUTALBITAL", "CAFFEINE"],
          },
        },
        {
          application_number: "ANDA216617",
          submissions: [
            { submission_status: "AP", submission_status_date: "20200101" },
          ],
          products: [
            { marketing_status: "Prescription", brand_name: "ACETAMINOPHEN" },
          ],
          openfda: {
            brand_name: ["ACETAMINOPHEN"],
            generic_name: ["ACETAMINOPHEN"],
            substance_name: ["ACETAMINOPHEN"],
          },
        },
      ],
    });
    mock.install();

    const result = await lookupDrug("acetaminophen", OPTS);

    expect(result.status).toBe("approved");
    expect(result.genericName?.toLowerCase()).toBe("acetaminophen");
    expect(result.genericName?.toLowerCase()).not.toBe("ibuprofen");
  });
});
