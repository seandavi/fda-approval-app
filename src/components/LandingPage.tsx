import { InputPanel, type InputMode } from "./InputPanel";
import { SettingsPanel } from "./SettingsPanel";
import type { AppSettings } from "../types";

interface Props {
  mode: InputMode;
  onModeChange: (m: InputMode) => void;
  inputValue: string;
  onInputChange: (v: string) => void;
  onSubmit: () => void;
  running: boolean;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  batchLimit: number;
}

// Layer hits in the resolver, paired with what the layer is good at —
// shown as a compact workflow strip on the landing page so newcomers can
// see at a glance what the app actually does behind the textarea.
const PIPELINE: Array<{ n: number; title: string; subtitle: string }> = [
  {
    n: 1,
    title: "Drugs@FDA",
    subtitle: "Brand + generic name match",
  },
  {
    n: 2,
    title: "Label",
    subtitle: "Approved label fallback",
  },
  {
    n: 3,
    title: "NDC",
    subtitle: "OTC monograph + unapproved",
  },
  {
    n: 4,
    title: "RxNorm",
    subtitle: "NLM clinical naming",
  },
  {
    n: 5,
    title: "ChEMBL",
    subtitle: "Research code → INN",
  },
  {
    n: 6,
    title: "ClinicalTrials.gov",
    subtitle: "Last-resort INN translation",
  },
  {
    n: 7,
    title: "LLM arbiter",
    subtitle: "Verify / correct, grounded in label",
  },
];

export function LandingPage({
  mode,
  onModeChange,
  inputValue,
  onInputChange,
  onSubmit,
  running,
  settings,
  onSettingsChange,
  batchLimit,
}: Props) {
  return (
    <div className="max-w-5xl mx-auto px-6 py-8 lg:py-12 space-y-8">
      {/* The gap statement — what this app exists for. Kept short so it's
          glanceable but specific enough to set expectations on scope. */}
      <section>
        <h2 className="text-2xl lg:text-3xl font-bold text-slate-900 tracking-tight">
          Resolve drug names to FDA approval status — including the
          indications they're approved for.
        </h2>
        <p className="mt-3 text-sm lg:text-base text-slate-600 leading-relaxed max-w-3xl">
          Paste a list of drug names — brand, generic, or internal research
          codes — and get back the original FDA approval (application number,
          date, sponsor), plus the verbatim indications from the current FDA
          label. Built for oncology and clinical research workflows where
          consistent regulatory grounding matters.
        </p>
      </section>

      {/* Compact workflow strip. Hidden on the smallest viewports — the
          headline + input are the priority there. */}
      <section
        aria-label="Lookup pipeline overview"
        className="hidden sm:block"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
          How it resolves a name
        </h3>
        <ol className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          {PIPELINE.map((s) => (
            <li
              key={s.n}
              className="rounded-md bg-white ring-1 ring-slate-200 px-3 py-2 text-xs flex items-start gap-2"
            >
              <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-800 font-semibold text-[10px]">
                {s.n}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-slate-900 truncate">
                  {s.title}
                </span>
                <span className="block text-slate-500 leading-tight">
                  {s.subtitle}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[11px] text-slate-500">
          Each layer is tried in order until a match is found. Layer 7
          (Gemini via a project-owned proxy) verifies the deterministic
          result against the current FDA label and corrects when the
          original innovator approval is missing from openFDA.
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2">
          <InputPanel
            mode={mode}
            onModeChange={onModeChange}
            value={inputValue}
            onChange={onInputChange}
            onSubmit={onSubmit}
            disabled={running}
            batchLimit={batchLimit}
          />
        </div>
        <div>
          <SettingsPanel settings={settings} onChange={onSettingsChange} />
        </div>
      </div>
    </div>
  );
}
