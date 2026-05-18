import { useState } from "react";
import { reportResultUrl } from "../feedback";
import type { DrugResult } from "../types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  result: DrugResult | null;
}

// Right-side master-detail panel that surfaces the full per-drug record:
// status, indications (verbatim from the FDA label), arbiter verdict,
// raw label text (collapsed), and the per-API source trail. The compact
// table on the left has the high-level columns; this is where you go for
// the full picture on a single drug.
export function DetailPanel({ result }: Props) {
  if (!result) {
    return (
      <aside className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200 p-6 text-sm text-slate-500 leading-relaxed">
        <p className="font-medium text-slate-700">No drug selected</p>
        <p className="mt-2">
          Click any row to see the full FDA-label indications, sources,
          and arbiter rationale here.
        </p>
      </aside>
    );
  }

  return (
    <aside className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200 overflow-hidden flex flex-col">
      <Header result={result} />
      <div className="overflow-y-auto px-5 py-4 space-y-5 flex-1">
        <SummaryGrid result={result} />
        <IndicationsBlock result={result} />
        <ArbiterBlock result={result} />
        <LabelTextAccordion result={result} />
        <SourcesBlock result={result} />
      </div>
    </aside>
  );
}

function Header({ result }: { result: DrugResult }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-slate-900 truncate">
            {result.brandName ?? result.inputName}
          </h2>
          {result.status !== "pending" && (
            <StatusBadge status={result.status} />
          )}
        </div>
        <p className="text-xs text-slate-500 mt-0.5 truncate">
          input: <span className="font-mono">{result.inputName}</span>
          {result.resolvedINN && (
            <>
              {" "}· resolved to{" "}
              <span className="font-mono">{result.resolvedINN}</span>
            </>
          )}
        </p>
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
  );
}

function SummaryGrid({ result }: { result: DrugResult }) {
  const rows: Array<[string, React.ReactNode]> = [
    ["Brand", result.brandName ?? "—"],
    ["Generic", result.genericName ?? "—"],
    ["Application", result.applicationNumber ?? "—"],
    ["Type", result.applicationType ?? "—"],
    ["Approval date", result.approvalDate ?? "—"],
    ["Sponsor", result.sponsor ?? "—"],
    ["Resolved via", result.resolvedVia ?? "—"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col">
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">
            {label}
          </dt>
          <dd className="text-slate-800 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function IndicationsBlock({ result }: { result: DrugResult }) {
  const hasCurrent = (result.currentIndications?.length ?? 0) > 0;
  const hasOriginal = !!result.originalIndication;
  if (!hasCurrent && !hasOriginal) return null;

  const siblingApp =
    result.indicationApplicationNumber &&
    result.applicationNumber &&
    result.indicationApplicationNumber !== result.applicationNumber
      ? result.indicationApplicationNumber
      : null;

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
        Indications{" "}
        <span className="font-normal normal-case text-slate-400">
          (current FDA label, verbatim)
        </span>
      </h3>
      {siblingApp && (
        <p className="text-[11px] text-slate-500 mb-2">
          Indications shown are from sibling application{" "}
          <code className="bg-slate-100 px-1 rounded">{siblingApp}</code> —
          openFDA has no current label for the resolved application but the
          sibling covers the same molecule.
        </p>
      )}
      {hasOriginal && (
        <p className="text-xs text-slate-600 mb-3">
          <span className="font-semibold text-slate-700">
            Original approval:
          </span>{" "}
          {result.originalIndication}
          <span className="ml-1.5 inline-flex items-center rounded bg-slate-100 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-slate-500 ring-1 ring-slate-200">
            LLM
          </span>
        </p>
      )}
      {hasCurrent ? (
        <ul className="space-y-1.5 text-sm text-slate-800 list-disc list-outside pl-5 marker:text-violet-400">
          {result.currentIndications!.map((ind, i) => (
            <li key={i} className="leading-snug">
              {ind}
            </li>
          ))}
        </ul>
      ) : (
        <NoCurrentIndicationsHint result={result} />
      )}
    </section>
  );
}

// Differentiates the reasons currentIndications could be empty so the
// user can tell whether to retry, ignore, or report the result (#37).
function NoCurrentIndicationsHint({ result }: { result: DrugResult }) {
  const hasLabel = !!result.labelIndicationText?.trim();
  if (hasLabel) {
    // The label text WAS fetched and made it to the arbiter — the model
    // just didn't enumerate. This is the #37 failure mode.
    return (
      <p className="text-xs text-slate-500">
        The resolved label is{" "}
        <span className="tabular-nums">
          {result.labelIndicationText!.length.toLocaleString()}
        </span>{" "}
        characters of indication text (visible below), but Layer 7
        returned no enumerated list. Likely a model omission — please
        report this row so the prompt can be tightened.
      </p>
    );
  }
  return (
    <p className="text-xs text-slate-500">
      No <code className="bg-slate-100 px-1 rounded">indications_and_usage</code>{" "}
      section was available on the resolved label (sometimes the case for
      older NDAs whose modern label is fragmented or absent in openFDA).
    </p>
  );
}

// Detect whether Layer 7 was attempted but didn't return a usable
// verdict. The arbiter is gated by status (skipped for OTC monograph /
// unapproved-marketed), so we infer "should have run" from the status
// alone — pending results don't qualify since the arbiter hasn't had a
// chance to run yet. If a source row mentions the LLM proxy, that's
// stronger evidence that we tried and failed (#32).
function arbiterRanButFailed(result: DrugResult): boolean {
  if (result.llmAgreement || result.llmRationale) return false;
  if (
    result.status === "pending" ||
    result.status === "otc_monograph" ||
    result.status === "unapproved_marketed"
  ) {
    return false;
  }
  return result.sources.some((s) => s.api.startsWith("llm/"));
}

function ArbiterBlock({ result }: { result: DrugResult }) {
  // Surface arbiter failures explicitly — otherwise an offline / errored
  // proxy is indistinguishable from a successful no-op run, and users
  // wonder why indications are missing (#32).
  if (arbiterRanButFailed(result)) {
    const llmSource = result.sources.find((s) => s.api.startsWith("llm/"));
    return (
      <section className="rounded-md ring-1 px-3 py-2.5 text-xs bg-slate-100 ring-slate-200 text-slate-700">
        <div className="font-semibold">LLM arbiter unavailable</div>
        <p className="mt-1 leading-relaxed">
          Layer 7 was attempted but did not return a verdict. The result
          reflects the deterministic pipeline only — indication extraction
          and arbiter cross-checks are not available for this row.
        </p>
        {llmSource?.detail && (
          <p className="mt-1 text-[11px] opacity-75">
            Reason: <code>{llmSource.detail}</code>
          </p>
        )}
      </section>
    );
  }

  if (!result.llmAgreement && !result.llmRationale) return null;

  const tone =
    result.llmAgreement === "correct"
      ? "bg-amber-50 ring-amber-200 text-amber-900"
      : result.llmAgreement === "confirm"
        ? "bg-emerald-50 ring-emerald-200 text-emerald-900"
        : "bg-slate-100 ring-slate-200 text-slate-700";

  const headline =
    result.llmAgreement === "correct"
      ? "LLM corrected the pipeline"
      : result.llmAgreement === "confirm"
        ? "LLM confirmed the pipeline"
        : "LLM verdict";

  return (
    <section className={`rounded-md ring-1 px-3 py-2.5 text-xs ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{headline}</span>
        {result.llmConfidence && (
          <span className="text-[10px] uppercase tracking-wide opacity-75">
            confidence: {result.llmConfidence}
          </span>
        )}
      </div>
      {result.llmRationale && (
        <p className="mt-1 leading-relaxed">{result.llmRationale}</p>
      )}
      {result.pipelineApplicationNumber && (
        <div className="mt-2 text-[11px] opacity-80">
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
    </section>
  );
}

function LabelTextAccordion({ result }: { result: DrugResult }) {
  const [open, setOpen] = useState(false);
  if (!result.labelIndicationText) return null;

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700 inline-flex items-center gap-1.5"
        aria-expanded={open}
      >
        <span>{open ? "▾" : "▸"}</span>
        Raw label indications text
        <span className="text-[10px] font-normal normal-case text-slate-400">
          ({result.labelIndicationText.length.toLocaleString()} chars)
        </span>
      </button>
      {open && (
        <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-slate-50 ring-1 ring-slate-200 p-3 text-[11px] font-mono leading-relaxed text-slate-700">
          {result.labelIndicationText}
        </pre>
      )}
    </section>
  );
}

function SourcesBlock({ result }: { result: DrugResult }) {
  if (result.sources.length === 0) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
        Sources
      </h3>
      <table className="w-full text-[11px]">
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
            <tr key={i} className="border-t border-slate-200 align-top">
              <td className="py-1 pr-3 font-mono">{s.api}</td>
              <td className="py-1 pr-3">
                {s.hit ? (
                  <span className="text-emerald-700">✓</span>
                ) : (
                  <span className="text-slate-400">·</span>
                )}
              </td>
              <td className="py-1 pr-3 text-slate-700">{s.detail ?? ""}</td>
              <td className="py-1 whitespace-nowrap">
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    title={s.url}
                    aria-label={`Open ${s.api} request URL in a new tab`}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200 bg-white hover:bg-slate-50 hover:text-violet-700 hover:ring-violet-300"
                  >
                    Open
                    <span aria-hidden="true">↗</span>
                  </a>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
