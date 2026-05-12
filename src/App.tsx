import { useCallback, useEffect, useMemo, useState } from "react";
import { trackEvent } from "./analytics";
import { InputPanel, type InputMode } from "./components/InputPanel";
import { ProgressBar } from "./components/ProgressBar";
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
    gaMeasurementId: import.meta.env.VITE_GA_MEASUREMENT_ID ?? "",
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

export function App() {
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
    <div className="min-h-screen">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <h1 className="text-lg font-semibold text-slate-900">
            FDA Drug Approval Lookup
          </h1>
          <p className="text-xs text-slate-500">
            Layered resolution across openFDA, RxNorm, ChEMBL, and
            ClinicalTrials.gov.
          </p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
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

        <ResultsTable
          results={results}
          defaultExpandSources={settings.showSourcesByDefault}
        />

        <footer className="text-center text-xs text-slate-400 pt-4 pb-8">
          Data sources: openFDA, RxNav (NLM), ChEMBL (EMBL-EBI),
          ClinicalTrials.gov. Not medical advice.
        </footer>
      </main>
    </div>
  );
}
