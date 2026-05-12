interface Props {
  completed: number;
  total: number;
}

export function ProgressBar({ completed, total }: Props) {
  if (total === 0) return null;
  const pct = Math.round((completed / total) * 100);
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
        <div
          className="h-full bg-sky-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-slate-600 tabular-nums whitespace-nowrap">
        {completed} of {total}
      </div>
    </div>
  );
}
