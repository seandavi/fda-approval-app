import { useCallback, useEffect, useMemo, useState } from "react";
import { trackEvent } from "./analytics";
import { AboutPage } from "./components/AboutPage";
import { InputPanel, type InputMode } from "./components/InputPanel";
import { genericFeedbackUrl } from "./feedback";
import { ProgressBar } from "./components/ProgressBar";
import { ResultsStrip } from "./components/ResultsStrip";
import { ResultsTable } from "./components/ResultsTable";
import { SettingsPanel } from "./components/SettingsPanel";
import { lookupBatch } from "./lookup";
import { parseBatchInput } from "./normalize";
import type { AppSettings, DrugResult } from "./types";

const SETTINGS_KEY = "fda_lookup_settings_v1";

const BATCH_LIMIT = (() => {
  const raw = Number(import.meta.env.VITE_BATCH_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
})();

function defaultSettings(): AppSettings {
  return {
    openfdaApiKey: import.meta.env.VITE_OPENFDA_API_KEY ?? "",
    cacheTtlDays: 7,
    showSourcesByDefault: false,
  };
}

function loadSettings(): AppSettings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...base, ...parsed };
  } catch {
    return base;
  }
}

function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

type View = "lookup" | "about";

export function App() {
  const [view, setView] = useState<View>("lookup");
  const [mode, setMode] = useState<InputMode>("batch");
  const [inputValue, setInputValue] = useState("");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [results, setResults] = useState<DrugResult[]>([]);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [running, setRunning] = useState(false);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const parsedNames = useMemo(() => {
    if (mode === "single") {
      const t = inputValue.trim();
      return t ? [t] : [];
    }
    return parseBatchInput(inputValue);
  }, [mode, inputValue]);

  const handleSubmit = useCallback(async () => {
    if (parsedNames.length === 0 || running) return;
    if (parsedNames.length > BATCH_LIMIT) return;
    setRunning(true);

    const placeholders: DrugResult[] = parsedNames.map((name) => ({
      inputName: name,
      normalizedName: name,
      status: "pending",
      sources: [],
      cached: false,
      lookedUpAt: new Date().toISOString(),
    }));
    setResults(placeholders);
    setProgress({ completed: 0, total: parsedNames.length });

    trackEvent("lookup_started", {
      batch_size: parsedNames.length,
      mode,
    });
    const startedAt = performance.now();

    const finalResults: DrugResult[] = [...placeholders];

    await lookupBatch(
      parsedNames,
      {
        apiKey: settings.openfdaApiKey,
        ttlDays: settings.cacheTtlDays,
        useCache: settings.cacheTtlDays > 0,
      },
      (completedCount, r) => {
        const idx = finalResults.findIndex(
          (existing) =>
            existing.status === "pending" && existing.inputName === r.inputName
        );
        if (idx >= 0) finalResults[idx] = r;
        setResults([...finalResults]);
        setProgress({ completed: completedCount, total: parsedNames.length });
      }
    );

    const duration = Math.round(performance.now() - startedAt);
    const approved = finalResults.filter((r) => r.status === "approved").length;
    const notFound = finalResults.filter((r) => r.status === "not_found").length;
    const errored = finalResults.filter((r) => r.status === "error").length;

    trackEvent("lookup_completed", {
      batch_size: parsedNames.length,
      approved_count: approved,
      not_found_count: notFound,
      error_count: errored,
      duration_ms: duration,
    });

    setRunning(false);
  }, [parsedNames, running, mode, settings]);

  return (
    <div className="lg:h-screen lg:flex lg:flex-col lg:overflow-hidden">
      <header className="bg-gradient-to-r from-violet-700 to-violet-900 text-white flex-shrink-0">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              FDA Drug Approval Lookup
            </h1>
            <p className="text-xs text-violet-200 mt-0.5">
              Resolve drug names — brands, INNs, or internal codes — across
              openFDA, RxNorm, ChEMBL, and ClinicalTrials.gov.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <nav className="inline-flex rounded-md bg-white/15 ring-1 ring-white/20 p-0.5 text-xs backdrop-blur">
              <button
                type="button"
                onClick={() => setView("lookup")}
                className={`px-3 py-1.5 rounded transition-colors ${
                  view === "lookup"
                    ? "bg-white text-violet-900 font-semibold shadow-sm"
                    : "text-violet-100 hover:text-white"
                }`}
              >
                Lookup
              </button>
              <button
                type="button"
                onClick={() => setView("about")}
                className={`px-3 py-1.5 rounded transition-colors ${
                  view === "about"
                    ? "bg-white text-violet-900 font-semibold shadow-sm"
                    : "text-violet-100 hover:text-white"
                }`}
              >
                About
              </button>
            </nav>
            <a
              href={genericFeedbackUrl()}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-violet-200 hover:text-white inline-flex items-center gap-1"
              title="Open a GitHub issue with feedback or a bug report"
            >
              Feedback
              <span aria-hidden="true" className="text-[10px]">↗</span>
            </a>
          </div>
        </div>
      </header>

      {view === "about" ? (
        <main className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
          <AboutPage />
        </main>
      ) : (
      <main className="lg:flex-1 lg:min-h-0 lg:overflow-hidden">
        {/* Two-column dashboard. Page is viewport-locked on lg+ — the left
            rail (input + settings) stays put while only the results panel
            scrolls internally. Stacks and scrolls normally on narrow
            viewports. */}
        <div className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 lg:h-full lg:overflow-hidden">
          <aside className="lg:col-span-4 xl:col-span-3 space-y-4 lg:overflow-y-auto lg:min-h-0 lg:pr-2">
            <InputPanel
              mode={mode}
              onModeChange={setMode}
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              disabled={running}
              batchLimit={BATCH_LIMIT}
            />
            {progress.total > 0 && (
              <div className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200 px-4 py-3">
                <ProgressBar
                  completed={progress.completed}
                  total={progress.total}
                />
              </div>
            )}
            <SettingsPanel settings={settings} onChange={setSettings} />
          </aside>

          <section className="lg:col-span-8 xl:col-span-9 space-y-4 lg:flex lg:flex-col lg:min-h-0">
            <ResultsStrip results={results} />
            {results.length === 0 ? (
              <div className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200 p-12 text-center lg:flex-1 lg:flex lg:flex-col lg:items-center lg:justify-center">
                <p className="text-sm text-slate-600">
                  Enter one or more drug names on the left to start a lookup.
                </p>
                <p className="text-xs text-slate-400 mt-2">
                  Brand names, generic INNs, and internal company codes all work.
                </p>
              </div>
            ) : (
              <ResultsTable
                results={results}
                defaultExpandSources={settings.showSourcesByDefault}
              />
            )}
          </section>
        </div>
      </main>
      )}

      <footer className="text-center text-xs text-slate-400 py-3 border-t border-slate-200 bg-white flex-shrink-0">
        Data sources: openFDA, RxNav (NLM), ChEMBL (EMBL-EBI),
        ClinicalTrials.gov. Not medical advice.
      </footer>
    </div>
  );
}
