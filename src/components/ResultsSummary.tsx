import type { ApprovalStatus, DrugResult } from "../types";

interface TileSpec {
  label: string;
  status: ApprovalStatus;
  ring: string;
  bg: string;
  text: string;
}

const TILES: TileSpec[] = [
  {
    label: "Approved",
    status: "approved",
    ring: "ring-emerald-200",
    bg: "bg-emerald-50",
    text: "text-emerald-900",
  },
  {
    label: "Discontinued",
    status: "discontinued",
    ring: "ring-amber-200",
    bg: "bg-amber-50",
    text: "text-amber-900",
  },
  {
    label: "Not Found",
    status: "not_found",
    ring: "ring-rose-200",
    bg: "bg-rose-50",
    text: "text-rose-900",
  },
  {
    label: "Errors",
    status: "error",
    ring: "ring-slate-300",
    bg: "bg-slate-50",
    text: "text-slate-900",
  },
];

export function ResultsSummary({ results }: { results: DrugResult[] }) {
  if (results.length === 0) return null;
  const counts = TILES.map((t) => ({
    ...t,
    count: results.filter((r) => r.status === t.status).length,
  }));
  const pending = results.filter((r) => r.status === "pending").length;
  const totalResolved = results.length - pending;

  return (
    <section
      className="grid grid-cols-2 md:grid-cols-4 gap-3"
      aria-label="Result summary"
    >
      {counts.map((t) => (
        <div
          key={t.status}
          className={`rounded-lg ring-1 ${t.ring} ${t.bg} px-4 py-3`}
        >
          <div className={`text-2xl font-semibold ${t.text} tabular-nums`}>
            {t.count}
          </div>
          <div className="text-xs uppercase tracking-wide text-slate-600 mt-0.5">
            {t.label}
          </div>
          {totalResolved > 0 && (
            <div className="text-[10px] text-slate-500 mt-1 tabular-nums">
              {Math.round((t.count / totalResolved) * 100)}% of resolved
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
