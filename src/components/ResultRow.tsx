import type { DrugResult } from "../types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  result: DrugResult;
  selected: boolean;
  onSelect: () => void;
}

// Small inline badge that surfaces the LLM verdict in the resolved-via cell.
function LlmBadge({ result }: { result: DrugResult }) {
  if (!result.llmAgreement) return null;
  const styles: Record<string, string> = {
    confirm:
      "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200",
    correct:
      "bg-amber-100 text-amber-900 ring-1 ring-amber-300",
    unknown:
      "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
  };
  const labels: Record<string, string> = {
    confirm: "✓ LLM",
    correct: "↻ LLM",
    unknown: "? LLM",
  };
  return (
    <span
      className={`ml-1 inline-flex items-center rounded px-1 py-px text-[10px] font-medium align-middle ${styles[result.llmAgreement] ?? ""}`}
      title={result.llmRationale ?? undefined}
    >
      {labels[result.llmAgreement]}
    </span>
  );
}

const STATUS_BORDER: Record<string, string> = {
  approved: "border-l-emerald-500",
  otc_monograph: "border-l-sky-500",
  unapproved_marketed: "border-l-orange-500",
  discontinued: "border-l-amber-500",
  not_found: "border-l-rose-400",
  pending: "border-l-violet-400",
  error: "border-l-slate-400",
};

// Truncate "Original indication" to a single line in the table. Full
// indication list lives in the detail panel on the right.
function truncate(s: string | undefined, max = 60): string {
  if (!s) return "—";
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

export function ResultRow({ result, selected, onSelect }: Props) {
  return (
    <tr
      onClick={onSelect}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`border-t border-slate-200 border-l-4 cursor-pointer outline-none ${
        STATUS_BORDER[result.status] ?? "border-l-transparent"
      } ${
        selected
          ? "bg-violet-50 hover:bg-violet-50"
          : "hover:bg-slate-50 focus:bg-slate-50"
      }`}
      aria-selected={selected}
    >
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
      <td
        className="px-3 py-2 align-top text-slate-700 max-w-xs"
        title={result.originalIndication ?? undefined}
      >
        {truncate(result.originalIndication, 60)}
      </td>
      <td className="px-3 py-2 align-top text-slate-700">
        {result.sponsor ?? "—"}
      </td>
      <td className="px-3 py-2 align-top text-slate-500 text-xs">
        <span>{result.resolvedVia ?? "—"}</span>
        <LlmBadge result={result} />
      </td>
    </tr>
  );
}
