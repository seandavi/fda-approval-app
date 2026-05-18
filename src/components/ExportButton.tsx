import { trackEvent } from "../analytics";
import type { DrugResult } from "../types";
import { SHORT_SHA } from "../version";

const COLUMNS: Array<{ header: string; pick: (r: DrugResult) => string }> = [
  { header: "inputName", pick: (r) => r.inputName },
  { header: "resolvedINN", pick: (r) => r.resolvedINN ?? "" },
  { header: "status", pick: (r) => r.status },
  { header: "applicationNumber", pick: (r) => r.applicationNumber ?? "" },
  { header: "applicationType", pick: (r) => r.applicationType ?? "" },
  { header: "brandName", pick: (r) => r.brandName ?? "" },
  { header: "genericName", pick: (r) => r.genericName ?? "" },
  { header: "approvalDate", pick: (r) => r.approvalDate ?? "" },
  { header: "sponsor", pick: (r) => r.sponsor ?? "" },
  { header: "resolvedVia", pick: (r) => r.resolvedVia ?? "" },
  // LLM verifier audit trail. llmAgreement is empty when Layer 7 didn't run
  // (e.g. otc_monograph results, or the proxy was disabled in dev).
  { header: "llmAgreement", pick: (r) => r.llmAgreement ?? "" },
  { header: "llmConfidence", pick: (r) => r.llmConfidence ?? "" },
  { header: "llmRationale", pick: (r) => r.llmRationale ?? "" },
  // Populated when the LLM overrode a deterministic-pipeline candidate, so
  // a CSV consumer can reconstruct both the original and the corrected
  // answer side by side.
  {
    header: "pipelineApplicationNumber",
    pick: (r) => r.pipelineApplicationNumber ?? "",
  },
  {
    header: "pipelineApprovalDate",
    pick: (r) => r.pipelineApprovalDate ?? "",
  },
  {
    header: "pipelineResolvedVia",
    pick: (r) => r.pipelineResolvedVia ?? "",
  },
  // Indications from the Layer 7 arbiter (#22). currentIndications is a
  // pipe-delimited list — pipe avoids both the field separator and the
  // semicolon used as field separator in some Excel locales.
  {
    header: "originalIndication",
    pick: (r) => r.originalIndication ?? "",
  },
  {
    header: "currentIndications",
    pick: (r) => (r.currentIndications ?? []).join("|"),
  },
  { header: "lookedUpAt", pick: (r) => r.lookedUpAt },
  { header: "app_version", pick: () => SHORT_SHA },
];

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(results: DrugResult[]): string {
  const lines = [COLUMNS.map((c) => c.header).join(",")];
  for (const r of results) {
    lines.push(COLUMNS.map((c) => csvEscape(c.pick(r))).join(","));
  }
  return lines.join("\n");
}

interface Props {
  results: DrugResult[];
}

export function ExportButton({ results }: Props) {
  const disabled = results.length === 0;

  function handleClick() {
    const csv = toCsv(results);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `fda-lookup-${dateStr}-${SHORT_SHA}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    trackEvent("export_csv", { row_count: results.length });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      Download CSV
    </button>
  );
}
