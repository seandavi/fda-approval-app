import { useEffect, useMemo, useState } from "react";
import type { DrugResult } from "../types";
import { DetailPanel } from "./DetailPanel";
import { ProgressBar } from "./ProgressBar";
import { ResultsStrip } from "./ResultsStrip";
import { ResultsTable, rowKey } from "./ResultsTable";

interface Props {
  results: DrugResult[];
  progress: { completed: number; total: number };
  running: boolean;
  onBack: () => void;
}

export function ResultsPage({ results, progress, running, onBack }: Props) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Auto-select the first non-pending result so the detail panel isn't
  // empty when the user lands here. Recomputed cheaply when results
  // change; doesn't override a user's explicit selection.
  useEffect(() => {
    if (selectedKey !== null) return;
    const idx = results.findIndex((r) => r.status !== "pending");
    if (idx >= 0) setSelectedKey(rowKey(results[idx], idx));
  }, [results, selectedKey]);

  const selected = useMemo<DrugResult | null>(() => {
    if (!selectedKey) return null;
    const found = results.findIndex((r, i) => rowKey(r, i) === selectedKey);
    return found >= 0 ? results[found] : null;
  }, [results, selectedKey]);

  return (
    <div className="max-w-7xl mx-auto px-6 py-4 lg:py-6 grid grid-cols-1 lg:grid-cols-12 gap-4 lg:h-full lg:overflow-hidden">
      <section className="lg:col-span-8 xl:col-span-9 space-y-3 lg:flex lg:flex-col lg:min-h-0">
        <div className="flex items-center justify-between gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-slate-600 hover:text-violet-700 inline-flex items-center gap-1 rounded px-2 py-1 ring-1 ring-slate-200 bg-white hover:ring-violet-300"
            disabled={running}
            title={
              running
                ? "Wait for the lookup to finish before editing the input"
                : "Edit the input list"
            }
          >
            <span aria-hidden="true">←</span> Edit input
          </button>
          {progress.total > 0 && progress.completed < progress.total && (
            <div className="flex-1 max-w-xs">
              <ProgressBar
                completed={progress.completed}
                total={progress.total}
              />
            </div>
          )}
        </div>
        <ResultsStrip results={results} />
        <ResultsTable
          results={results}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
      </section>
      <section className="lg:col-span-4 xl:col-span-3 lg:overflow-y-auto lg:min-h-0">
        <DetailPanel result={selected} />
      </section>
    </div>
  );
}
