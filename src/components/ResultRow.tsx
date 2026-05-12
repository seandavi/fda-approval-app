import { useState } from "react";
import { reportResultUrl } from "../feedback";
import type { DrugResult } from "../types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  result: DrugResult;
  defaultExpanded: boolean;
}

export function ResultRow({ result, defaultExpanded }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const statusBorder: Record<string, string> = {
    approved: "border-l-emerald-500",
    discontinued: "border-l-amber-500",
    not_found: "border-l-rose-400",
    pending: "border-l-violet-400",
    error: "border-l-slate-400",
  };

  return (
    <>
      <tr
        className={`border-t border-slate-200 border-l-4 ${
          statusBorder[result.status] ?? "border-l-transparent"
        } hover:bg-slate-50`}
      >
        <td className="px-3 py-2 align-top">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-slate-400 hover:text-slate-700"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
        </td>
        <td className="px-3 py-2 align-top">
          <div className="font-medium text-slate-900">{result.inputName}</div>
          {result.cached && (
            <span className="text-[10px] uppercase tracking-wide text-slate-500 bg-slate-100 px-1 rounded">
              cached
            </span>
          )}
        </td>
        <td className="px-3 py-2 align-top text-slate-700">
          {result.resolvedINN ?? result.genericName ?? "—"}
        </td>
        <td className="px-3 py-2 align-top">
          {result.status === "pending" ? (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-violet-500 border-r-transparent" />
          ) : (
            <StatusBadge status={result.status} />
          )}
        </td>
        <td className="px-3 py-2 align-top text-slate-700 font-mono text-xs">
          {result.applicationNumber ?? "—"}
        </td>
        <td className="px-3 py-2 align-top text-slate-700">
          {result.applicationType ?? "—"}
        </td>
        <td className="px-3 py-2 align-top text-slate-700">
          {result.brandName ?? "—"}
        </td>
        <td className="px-3 py-2 align-top text-slate-700">
          {result.sponsor ?? "—"}
        </td>
        <td className="px-3 py-2 align-top text-slate-500 text-xs">
          {result.resolvedVia ?? "—"}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-slate-100 bg-slate-50">
          <td colSpan={9} className="px-3 py-3">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <div className="text-xs text-slate-600">
                Looked up {new Date(result.lookedUpAt).toLocaleString()} · Normalized:{" "}
                <code className="bg-white px-1 rounded">{result.normalizedName}</code>
                {result.approvalDate && (
                  <>
                    {" "}· Approval date: <code>{result.approvalDate}</code>
                  </>
                )}
              </div>
              {result.status !== "pending" && (
                <a
                  href={reportResultUrl(result)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-shrink-0 text-xs text-slate-500 hover:text-violet-700 inline-flex items-center gap-1"
                  title="Open a pre-filled GitHub issue about this result"
                >
                  Report
                  <span aria-hidden="true" className="text-[10px]">↗</span>
                </a>
              )}
            </div>
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">API</th>
                  <th className="py-1 pr-3 font-medium">Hit</th>
                  <th className="py-1 pr-3 font-medium">Detail</th>
                  <th className="py-1 font-medium">URL</th>
                </tr>
              </thead>
              <tbody>
                {result.sources.map((s, i) => (
                  <tr key={i} className="border-t border-slate-200">
                    <td className="py-1 pr-3 font-mono">{s.api}</td>
                    <td className="py-1 pr-3">
                      {s.hit ? (
                        <span className="text-emerald-700">✓</span>
                      ) : (
                        <span className="text-slate-400">·</span>
                      )}
                    </td>
                    <td className="py-1 pr-3 text-slate-700">{s.detail ?? ""}</td>
                    <td className="py-1 text-slate-500 break-all">
                      {s.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-violet-600"
                        >
                          {s.url}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
