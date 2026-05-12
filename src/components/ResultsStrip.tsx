import type { ApprovalStatus, DrugResult } from "../types";

interface Stat {
  label: string;
  status: ApprovalStatus;
  dotColor: string;
  text: string;
}

const STATS: Stat[] = [
  { label: "Approved",            status: "approved",            dotColor: "bg-emerald-500", text: "text-emerald-700" },
  { label: "OTC Monograph",       status: "otc_monograph",       dotColor: "bg-sky-500",     text: "text-sky-700"     },
  { label: "Marketed (Unapproved)", status: "unapproved_marketed", dotColor: "bg-orange-500", text: "text-orange-700"  },
  { label: "Discontinued",        status: "discontinued",        dotColor: "bg-amber-500",   text: "text-amber-700"   },
  { label: "Not Found",           status: "not_found",           dotColor: "bg-rose-500",    text: "text-rose-700"    },
  { label: "Errors",              status: "error",               dotColor: "bg-slate-500",   text: "text-slate-700"   },
];

export function ResultsStrip({ results }: { results: DrugResult[] }) {
  if (results.length === 0) return null;
  const total = results.length;

  return (
    <div className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <div className="font-semibold text-slate-900 tabular-nums">
        {total}
        <span className="text-xs font-normal text-slate-500 ml-1">
          {total === 1 ? "result" : "results"}
        </span>
      </div>
      <div className="h-4 w-px bg-slate-200" />
      {STATS.map((s) => {
        const count = results.filter((r) => r.status === s.status).length;
        if (count === 0) return null;
        return (
          <div key={s.status} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${s.dotColor}`} />
            <span className={`tabular-nums font-medium ${s.text}`}>{count}</span>
            <span className="text-xs text-slate-500">{s.label.toLowerCase()}</span>
          </div>
        );
      })}
    </div>
  );
}
