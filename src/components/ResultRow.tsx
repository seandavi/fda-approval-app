import { useState } from "react";
import { reportResultUrl } from "../feedback";
import type { DrugResult } from "../types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  result: DrugResult;
  defaultExpanded: boolean;
}

// Small inline badge that surfaces the LLM verdict in the resolved-via cell.
// Hover or focus reveals the rationale; clicking expands the full row.
function LlmBadge({ result }: { result: DrugResult }) {
  if (!result.llmAgreement) return null;
  const styles: Record<string, string> = {
    confirm:
      "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-200",
    correct:
      "bg-amber-100 text-amber-900 ring-1 ring-amber-300 hover:bg-amber-200",
    unknown:
      "bg-slate-100 text-slate-700 ring-1 ring-slate-200 hover:bg-slate-200",
  };
  const labels: Record<string, string> = {
    confirm: "✓ LLM",
    correct: "↻ LLM",
    unknown: "? LLM",
  };
  const tip = [
    result.llmConfidence ? `Confidence: ${result.llmConfidence}` : null,
    result.llmRationale ?? null,
  ]
    .filter(Boolean)
    .join(" — ");
  return (
    <span className="relative inline-block group ml-1 align-middle">
      <span
        tabIndex={0}
        role="button"
        aria-label={`LLM ${result.llmAgreement} — ${result.llmRationale ?? ""}`}
        className={`inline-flex items-center cursor-help rounded px-1 py-px text-[10px] font-medium ${styles[result.llmAgreement] ?? ""}`}
      >
        {labels[result.llmAgreement]}
      </span>
      {tip && (
        <span
          role="tooltip"
          className="pointer-events-none absolute z-20 bottom-full right-0 mb-1 hidden group-hover:block group-focus-within:block whitespace-normal w-72 rounded-md bg-slate-900 px-3 py-2 text-xs font-normal text-white shadow-lg leading-relaxed"
        >
          {tip}
        </span>
      )}
    </span>
  );
}

export function ResultRow({ result, defaultExpanded }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const statusBorder: Record<string, string> = {
    approved: "border-l-emerald-500",
    otc_monograph: "border-l-sky-500",
    unapproved_marketed: "border-l-orange-500",
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
        <td className="px-3 py-2 align-top text-slate-700 whitespace-nowrap tabular-nums">
          {result.approvalDate ?? "—"}
        </td>
        <td className="px-3 py-2 align-top text-slate-700">
          {result.sponsor ?? "—"}
        </td>
        <td className="px-3 py-2 align-top text-slate-500 text-xs">
          <span>{result.resolvedVia ?? "—"}</span>
          <LlmBadge result={result} />
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-slate-100 bg-slate-50">
          <td colSpan={10} className="px-3 py-3">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <div className="text-xs text-slate-600">
                Looked up {new Date(result.lookedUpAt).toLocaleString()} · Normalized:{" "}
                <code className="bg-white px-1 rounded">{result.normalizedName}</code>
                {result.marketingCategory && (
                  <>
                    {" "}· Marketing: <code>{result.marketingCategory}</code>
                  </>
                )}
                {result.llmConfidence && (
                  <>
                    {" "}· LLM confidence: <code>{result.llmConfidence}</code>
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
            {result.llmRationale && (
              <div
                className={`mt-3 rounded-md ring-1 px-3 py-2 text-xs ${
                  result.llmAgreement === "correct"
                    ? "bg-amber-50 ring-amber-200 text-amber-900"
                    : result.llmAgreement === "confirm"
                      ? "bg-emerald-50 ring-emerald-200 text-emerald-900"
                      : "bg-slate-100 ring-slate-200 text-slate-700"
                }`}
              >
                <span className="font-semibold">
                  {result.llmAgreement === "correct"
                    ? "LLM corrected the pipeline:"
                    : result.llmAgreement === "confirm"
                      ? "LLM confirmed the pipeline:"
                      : "LLM verdict:"}
                </span>{" "}
                {result.llmRationale}
                {result.pipelineApplicationNumber && (
                  <div className="mt-1.5 text-[11px] opacity-80">
                    Pipeline originally returned{" "}
                    <code className="bg-white px-1 rounded line-through decoration-amber-700">
                      {result.pipelineApplicationNumber}
                    </code>{" "}
                    on{" "}
                    <code className="bg-white px-1 rounded line-through decoration-amber-700">
                      {result.pipelineApprovalDate ?? "—"}
                    </code>{" "}
                    (via {result.pipelineResolvedVia ?? "?"}).
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
