import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchMock } from "../test/fetchMock";
import { idVariants, queryChembl } from "./chembl";

describe("idVariants", () => {
  it("generates dash/space/strip variants without dupes", () => {
    expect(idVariants("ASG22CE")).toEqual(["ASG22CE", "ASG-22CE", "ASG 22CE"]);
    expect(idVariants("ASG-22CE")).toContain("ASG22CE");
    expect(idVariants("AMG107")).toEqual(["AMG107", "AMG-107", "AMG 107"]);
  });
});

describe("queryChembl variant fallback", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to hyphenated form when bare form misses (regression: ASG22CE)", async () => {
    // Exact "ASG22CE" lookup misses.
    mock.on(/iexact=ASG22CE&/, { molecules: [] });
    // Hyphenated "ASG-22CE" hits.
    mock.on(/iexact=ASG-22CE&/, {
      molecules: [
        {
          pref_name: "ENFORTUMAB VEDOTIN",
          molecule_chembl_id: "CHEMBL1234",
          molecule_synonyms: [
            { synonyms: "ENFORTUMAB VEDOTIN", syn_type: "INN" },
            { synonyms: "ASG-22CE", syn_type: "OTHER" },
          ],
        },
      ],
    });
    mock.install();

    const result = await queryChembl("ASG22CE");

    expect(result.resolvedINN).toBe("enfortumab vedotin");
    // The variant fallback should be recorded in sources.
    expect(result.sources.some((s) => s.api.includes("variant"))).toBe(true);
  });

  it("returns no INN when no variant matches", async () => {
    mock.on(/molecule\.json/, { molecules: [] });
    mock.install();

    const result = await queryChembl("XYZ999");
    expect(result.resolvedINN).toBeUndefined();
  });
});
