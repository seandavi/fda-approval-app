import { useMemo, useState } from "react";
import type { ApprovalStatus, DrugResult } from "../types";
import { ExportButton } from "./ExportButton";
import { InfoTooltip } from "./InfoTooltip";
import { ResultRow } from "./ResultRow";

type SortKey =
  | "inputName"
  | "resolvedINN"
  | "status"
  | "applicationNumber"
  | "applicationType"
  | "brandName"
  | "approvalDate"
  | "originalIndication"
  | "sponsor"
  | "resolvedVia";

type StatusFilter = "all" | ApprovalStatus;

interface Props {
  results: DrugResult[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

const HEADERS: Array<{ key: SortKey; label: string; tooltip?: string }> = [
  { key: "inputName", label: "Input" },
  {
    key: "resolvedINN",
    label: "Resolved As",
    tooltip:
      "The canonical name we resolved your input to. For brand names this is the generic name; for internal codes like MK-3475 this is the INN found via ChEMBL or ClinicalTrials.gov.",
  },
  {
    key: "status",
    label: "Status",
    tooltip:
      "approved = active FDA NDA/BLA/ANDA. otc_monograph = legally marketed under FDA's OTC monograph (no application; e.g. aspirin, ibuprofen). unapproved_marketed = marketed without FDA approval (homeopathic, etc.). discontinued = approved record but all products discontinued. not_found = no FDA record after all layers. error = network/parse failure.",
  },
  {
    key: "applicationNumber",
    label: "App #",
    tooltip:
      "FDA application number. NDA = New Drug Application (small molecule). BLA = Biologics License Application (biologic). ANDA = Abbreviated NDA (generic).",
  },
  { key: "applicationType", label: "Type" },
  { key: "brandName", label: "Brand" },
  {
    key: "approvalDate",
    label: "Approval Date",
    tooltip:
      "Earliest FDA approval date for the chosen application (NDA/BLA/ANDA). Sourced from openFDA drugsfda submissions; not populated for OTC monograph or unapproved-marketed records.",
  },
  {
    key: "originalIndication",
    label: "Original indication",
    tooltip:
      "Best-effort first-approval indication from the Layer 7 LLM arbiter, anchored to the candidate's approval date. Click the row to see the full current FDA-label indication list — that's the verbatim, authoritative one.",
  },
  { key: "sponsor", label: "Sponsor" },
  {
    key: "resolvedVia",
    label: "Source",
    tooltip:
      "Which pipeline layer produced the result: openfda_brand/generic = direct drugsfda hit; openfda_label = drug label fallback; openfda_ndc = NDC directory hit (covers OTC monograph and unapproved-marketed paths); rxnorm = NLM mapping. chembl/clinicaltrials in this column means an ID translation happened first.",
  },
];

function cmp(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

function valueFor(r: DrugResult, key: SortKey): string | undefined {
  switch (key) {
    case "inputName":
      return r.inputName;
    case "resolvedINN":
      return r.resolvedINN ?? r.genericName;
    case "status":
      return r.status;
    case "applicationNumber":
      return r.applicationNumber;
    case "applicationType":
      return r.applicationType;
    case "brandName":
      return r.brandName;
    case "approvalDate":
      return r.approvalDate;
    case "originalIndication":
      return r.originalIndication;
    case "sponsor":
      return r.sponsor;
    case "resolvedVia":
      return r.resolvedVia;
  }
}

export function rowKey(r: DrugResult, i: number): string {
  return `${r.inputName}-${i}`;
}

export function ResultsTable({ results, selectedKey, onSelect }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("inputName");
  const [sortAsc, setSortAsc] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>("all");

  // Annotate rows with their stable key before filtering/sorting, so the
  // detail-panel selection stays correctly mapped after a sort flip.
  const indexed = useMemo(
    () => results.map((r, i) => ({ r, key: rowKey(r, i) })),
    [results]
  );

  const filtered = useMemo(() => {
    const f =
      filter === "all"
        ? indexed
        : indexed.filter((x) => x.r.status === filter);
    const sorted = [...f].sort((a, b) => {
      const av = valueFor(a.r, sortKey);
      const bv = valueFor(b.r, sortKey);
      const c = cmp(av, bv);
      return sortAsc ? c : -c;
    });
    return sorted;
  }, [indexed, filter, sortKey, sortAsc]);

  if (results.length === 0) return null;

  return (
    <section className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200 overflow-hidden lg:flex-1 lg:flex lg:flex-col lg:min-h-0">
      <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0">
        <h2 className="text-sm font-semibold text-slate-900">
          Results ({results.length})
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-600">Filter:</label>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as StatusFilter)}
              className="text-xs rounded ring-1 ring-inset ring-slate-300 px-2 py-1"
            >
              <option value="all">All</option>
              <option value="approved">Approved</option>
              <option value="otc_monograph">OTC Monograph</option>
              <option value="unapproved_marketed">Marketed (Unapproved)</option>
              <option value="discontinued">Discontinued</option>
              <option value="not_found">Not Found</option>
              <option value="error">Error</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          <ExportButton
            results={results.filter((r) => r.status !== "pending")}
          />
        </div>
      </div>
      <div className="overflow-auto lg:flex-1 lg:min-h-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 sticky top-0 z-10">
            <tr>
              {HEADERS.map((h) => {
                const isActive = sortKey === h.key;
                return (
                  <th
                    key={h.key}
                    aria-sort={
                      isActive
                        ? sortAsc
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="px-3 py-2 font-medium select-none whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (sortKey === h.key) setSortAsc((v) => !v);
                        else {
                          setSortKey(h.key);
                          setSortAsc(true);
                        }
                      }}
                      className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1"
                    >
                      {h.label}
                      {isActive && (
                        <span className="ml-1 text-slate-400">
                          {sortAsc ? "▲" : "▼"}
                        </span>
                      )}
                    </button>
                    {h.tooltip && <InfoTooltip side="bottom" text={h.tooltip} />}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ r, key }) => (
              <ResultRow
                key={key}
                result={r}
                selected={selectedKey === key}
                onSelect={() => onSelect(key)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
