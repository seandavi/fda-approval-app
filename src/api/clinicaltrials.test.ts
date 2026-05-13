import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchMock } from "../test/fetchMock";
import { queryClinicalTrials } from "./clinicaltrials";

function studyWithInterventions(
  interventions: Array<{ name: string; otherNames?: string[] }>
) {
  return {
    protocolSection: {
      armsInterventionsModule: { interventions },
    },
  };
}

describe("queryClinicalTrials INN extraction", () => {
  let mock: FetchMock;

  beforeEach(() => {
    mock = new FetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not pull co-drug names from combination-trial interventions (regression: BA3011 + cyclophosphamide)", async () => {
    // A combination intervention should NOT leak the co-drug as an INN.
    mock.on("/studies", {
      studies: [
        studyWithInterventions([
          {
            name: "BA3011 + cyclophosphamide",
            otherNames: ["Cytoxan", "cyclophosphamide hydrate"],
          },
        ]),
      ],
    });
    mock.install();

    const result = await queryClinicalTrials("BA3011");
    expect(result.resolvedINN).toBeUndefined();
  });

  it("still extracts INN from a clean single-drug intervention with a dose suffix", async () => {
    mock.on("/studies", {
      studies: [
        studyWithInterventions([
          { name: "BA3011 50 mg", otherNames: ["mecbotamab vedotin"] },
        ]),
      ],
    });
    mock.install();

    const result = await queryClinicalTrials("BA3011");
    expect(result.resolvedINN).toBe("mecbotamab vedotin");
  });

  it("matches hyphen/space variants of the queried token", async () => {
    mock.on("/studies", {
      studies: [
        studyWithInterventions([
          { name: "BA-3011", otherNames: ["mecbotamab vedotin"] },
        ]),
      ],
    });
    mock.install();

    const result = await queryClinicalTrials("BA3011");
    expect(result.resolvedINN).toBe("mecbotamab vedotin");
  });
});
