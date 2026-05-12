import { useMemo, useState } from "react";
import type { ApprovalStatus, DrugResult } from "../types";
import { ResultRow } from "./ResultRow";

type SortKey =
  | "inputName"
  | "resolvedINN"
  | "status"
  | "applicationNumber"
  | "applicationType"
  | "brandName"
  | "sponsor"
  | "resolvedVia";

type StatusFilter = "all" | ApprovalStatus;

interface Props {
  results: DrugResult[];
  defaultExpandSources: boolean;
}

const HEADERS: Array<{ key: SortKey; label: string }> = [
  { key: "inputName", label: "Input" },
  { key: "resolvedINN", label: "Resolved As" },
  { key: "status", label: "Status" },
  { key: "applicationNumber", label: "App #" },
  { key: "applicationType", label: "Type" },
  { key: "brandName", label: "Brand" },
  { key: "sponsor", label: "Sponsor" },
  { key: "resolvedVia", label: "Source" },
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
    case "sponsor":
      return r.sponsor;
    case "resolvedVia":
      return r.resolvedVia;
  }
}

export function ResultsTable({ results, defaultExpandSources }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("inputName");
  const [sortAsc, setSortAsc] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>("all");

  const filtered = useMemo(() => {
    const f = filter === "all" ? results : results.filter((r) => r.status === filter);
    const sorted = [...f].sort((a, b) => {
      const av = valueFor(a, sortKey);
      const bv = valueFor(b, sortKey);
      const c = cmp(av, bv);
      return sortAsc ? c : -c;
    });
    return sorted;
  }, [results, filter, sortKey, sortAsc]);

  if (results.length === 0) return null;

  return (
    <section className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-900">
          Results ({results.length})
        </h2>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-600">Filter:</label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as StatusFilter)}
            className="text-xs rounded ring-1 ring-inset ring-slate-300 px-2 py-1"
          >
            <option value="all">All</option>
            <option value="approved">Approved</option>
            <option value="discontinued">Discontinued</option>
            <option value="not_found">Not Found</option>
            <option value="error">Error</option>
            <option value="pending">Pending</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 w-8" />
              {HEADERS.map((h) => (
                <th
                  key={h.key}
                  className="px-3 py-2 font-medium cursor-pointer select-none"
                  onClick={() => {
                    if (sortKey === h.key) setSortAsc((v) => !v);
                    else {
                      setSortKey(h.key);
                      setSortAsc(true);
                    }
                  }}
                >
                  {h.label}
                  {sortKey === h.key && (
                    <span className="ml-1 text-slate-400">
                      {sortAsc ? "▲" : "▼"}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <ResultRow
                key={`${r.inputName}-${i}`}
                result={r}
                defaultExpanded={defaultExpandSources}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
