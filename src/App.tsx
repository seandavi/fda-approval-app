import { useCallback, useEffect, useMemo, useState } from "react";
import { trackEvent } from "./analytics";
import { clearCache } from "./cache";
import { AboutPage } from "./components/AboutPage";
import { type InputMode } from "./components/InputPanel";
import { LandingPage } from "./components/LandingPage";
import { ResultsPage } from "./components/ResultsPage";
import { genericFeedbackUrl, repoUrl } from "./feedback";
import { lookupBatch } from "./lookup";
import { parseBatchInput } from "./normalize";
import type { AppSettings, DrugResult } from "./types";
import { COMMIT_URL, SHORT_SHA } from "./version";

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

// Shareable cache-reset URL: `?clear_cache=1` (or `?clear_cache` with no
// value) drops every cached result on first load. Used when a deploy
// changes resolver behavior and we need users to evict stale answers
// without explaining how to navigate browser DevTools. The settings key
// is preserved — only result cache entries (clearCache filters by
// prefix) are cleared.
//
// Runs at module-load time, NOT inside App. React 18 strict mode
// double-invokes `useState` lazy initializers (and any effect), and
// since this has side effects — calls clearCache(), strips the URL —
// the second invocation would see the URL already cleaned and return
// null, masking the banner. Moving the work to module scope sidesteps
// that: the module loads once, the side effect runs once, and the
// component just reads the resulting count.
function consumeClearCacheParam(): number | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("clear_cache")) return null;
  const count = clearCache();
  params.delete("clear_cache");
  const remaining = params.toString();
  const newUrl =
    window.location.pathname +
    (remaining ? `?${remaining}` : "") +
    window.location.hash;
  window.history.replaceState(null, "", newUrl);
  return count;
}

const INITIAL_CACHE_CLEARED_NOTICE: number | null = consumeClearCacheParam();

type View = "lookup" | "about";
// Two-phase flow: the landing page (input + workflow overview + settings)
// transitions to the results page when a lookup runs. "Edit input" on the
// results page returns to the landing with the input value preserved.
type Phase = "input" | "results";

export function App() {
  const [view, setView] = useState<View>("lookup");
  const [phase, setPhase] = useState<Phase>("input");
  const [mode, setMode] = useState<InputMode>("batch");
  const [inputValue, setInputValue] = useState("");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [results, setResults] = useState<DrugResult[]>([]);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [running, setRunning] = useState(false);
  // Notice for the `?clear_cache=1` URL knob — null means no banner.
  // The actual cache-clear ran at module-load (see
  // INITIAL_CACHE_CLEARED_NOTICE). We just surface the count here.
  const [cacheClearedNotice, setCacheClearedNotice] = useState<number | null>(
    INITIAL_CACHE_CLEARED_NOTICE
  );

  // Auto-dismiss the cache-cleared banner after a few seconds so it
  // doesn't linger across the rest of the user's session.
  useEffect(() => {
    if (cacheClearedNotice === null) return;
    const t = window.setTimeout(() => setCacheClearedNotice(null), 8000);
    return () => window.clearTimeout(t);
  }, [cacheClearedNotice]);

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
    setPhase("results");

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
        // The /api/llm-lookup Netlify Function is only present on the
        // production deploy. Vite dev (no `netlify dev`) would 404 on it,
        // so we gate proxy use to PROD by default — override with
        // VITE_ENABLE_LLM_PROXY=true if running `netlify dev` locally.
        enableLlmProxy:
          import.meta.env.PROD ||
          import.meta.env.VITE_ENABLE_LLM_PROXY === "true",
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
              Resolve drug names — brands, INNs, or internal codes — to
              their canonical FDA application, approval date, and current
              label indications.
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
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="text-violet-200 hover:text-white inline-flex items-center"
              title="View source on GitHub"
              aria-label="View source on GitHub"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.26 3.38.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .98-.31 3.2 1.18a11.1 11.1 0 0 1 5.83 0c2.22-1.49 3.2-1.18 3.2-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.26 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.66.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
              </svg>
            </a>
          </div>
        </div>
      </header>

      {cacheClearedNotice !== null && (
        <div
          role="status"
          className="flex-shrink-0 bg-violet-50 border-b border-violet-200 text-violet-900 px-6 py-2 text-xs flex items-center justify-between gap-4"
        >
          <span>
            <span className="font-semibold">Local cache cleared</span> ·{" "}
            {cacheClearedNotice === 0
              ? "no cached results to drop"
              : `${cacheClearedNotice} cached result${cacheClearedNotice === 1 ? "" : "s"} removed`}
            . Lookups will re-fetch from upstream.
          </span>
          <button
            type="button"
            onClick={() => setCacheClearedNotice(null)}
            className="text-violet-700 hover:text-violet-900"
            aria-label="Dismiss notice"
          >
            ×
          </button>
        </div>
      )}

      {view === "about" ? (
        <main className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
          <AboutPage />
        </main>
      ) : phase === "input" || results.length === 0 ? (
        <main className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
          <LandingPage
            mode={mode}
            onModeChange={setMode}
            inputValue={inputValue}
            onInputChange={setInputValue}
            onSubmit={handleSubmit}
            running={running}
            settings={settings}
            onSettingsChange={setSettings}
            batchLimit={BATCH_LIMIT}
          />
        </main>
      ) : (
        <main className="lg:flex-1 lg:min-h-0 lg:overflow-hidden">
          <ResultsPage
            results={results}
            progress={progress}
            running={running}
            onBack={() => setPhase("input")}
          />
        </main>
      )}

      <footer className="text-center text-xs text-slate-400 py-3 border-t border-slate-200 bg-white flex-shrink-0">
        Built by{" "}
        <a
          href="https://github.com/seandavi"
          target="_blank"
          rel="noreferrer"
          className="hover:text-slate-600 hover:underline underline-offset-2"
        >
          Sean Davis
        </a>{" "}
        · Data sources: openFDA, RxNav (NLM), ChEMBL (EMBL-EBI),
        ClinicalTrials.gov. Not medical advice. ·{" "}
        {COMMIT_URL ? (
          <a
            href={COMMIT_URL}
            target="_blank"
            rel="noreferrer"
            className="font-mono hover:text-slate-600 hover:underline underline-offset-2"
            title="View this build on GitHub"
          >
            {SHORT_SHA}
          </a>
        ) : (
          <span className="font-mono">{SHORT_SHA}</span>
        )}
      </footer>
    </div>
  );
}
