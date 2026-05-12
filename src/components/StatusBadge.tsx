import type { ApprovalStatus } from "../types";

const STYLES: Record<ApprovalStatus, string> = {
  approved: "bg-emerald-100 text-emerald-800 ring-emerald-600/20",
  discontinued: "bg-amber-100 text-amber-800 ring-amber-600/20",
  not_found: "bg-rose-100 text-rose-800 ring-rose-600/20",
  pending: "bg-violet-100 text-violet-800 ring-violet-600/20",
  error: "bg-slate-200 text-slate-700 ring-slate-500/20",
};

const LABELS: Record<ApprovalStatus, string> = {
  approved: "Approved",
  discontinued: "Discontinued",
  not_found: "Not Found",
  pending: "Pending",
  error: "Error",
};

export function StatusBadge({ status }: { status: ApprovalStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[status]}`}
    >
      {LABELS[status]}
    </span>
  );
}
