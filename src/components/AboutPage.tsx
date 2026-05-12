interface Source {
  name: string;
  org: string;
  url: string;
  role: string;
}

const SOURCES: Source[] = [
  {
    name: "openFDA",
    org: "U.S. Food and Drug Administration",
    url: "https://open.fda.gov/",
    role: "Authoritative source for approval status. The /drug/drugsfda and /drug/label endpoints return application numbers, submission status, sponsors, and marketing status.",
  },
  {
    name: "RxNorm",
    org: "U.S. National Library of Medicine (NIH)",
    url: "https://rxnav.nlm.nih.gov/",
    role: "Standardized drug name vocabulary. Maps brand and generic names to RxCUIs, which we look up to find an FDA application number.",
  },
  {
    name: "ChEMBL",
    org: "European Bioinformatics Institute (EMBL-EBI)",
    url: "https://www.ebi.ac.uk/chembl/",
    role: "Drug discovery database with structured synonym types (INN, USAN, FDA, RESEARCH_CODE, TRADE_NAME). Used to translate internal company codes like MK-3475 to a queryable INN.",
  },
  {
    name: "ClinicalTrials.gov",
    org: "U.S. National Library of Medicine (NIH)",
    url: "https://clinicaltrials.gov/",
    role: "Last-resort fallback for ID translation. We scan intervention otherNames in trials matching the queried compound for an INN-shaped alias.",
  },
];

interface LayerStep {
  n: number;
  title: string;
  detail: string;
}

const PIPELINE: LayerStep[] = [
  {
    n: 1,
    title: "openFDA /drug/drugsfda",
    detail: "Search by exact brand_name, then exact generic_name, then wildcard. On any submission with submission_status='AP', record the application number and approval date. If all products are marked Discontinued, set status accordingly.",
  },
  {
    n: 2,
    title: "openFDA /drug/label",
    detail: "Fallback for drugs that have a label but aren't in drugsfda. Matches when the label's marketing_category is NDA or BLA and openfda.application_number is present.",
  },
  {
    n: 3,
    title: "RxNorm",
    detail: "Resolve the input to an RxCUI, then query the FDA_APPLICATION_NUMBER property. If the value is prefixed NDA/BLA/ANDA, we have a hit.",
  },
  {
    n: 4,
    title: "ChEMBL",
    detail: "ID-to-INN translation when the FDA layers miss (e.g. internal codes like MEDI4736, AZD9291). We match against molecule_synonyms with syn_type='INN', then re-run layers 1-3 with the resolved INN.",
  },
  {
    n: 5,
    title: "ClinicalTrials.gov v2",
    detail: "Last resort. We scan top study results for interventions whose canonical name contains the query, then pick an INN-shaped otherName as the translated name and re-run layers 1-3.",
  },
];

interface SectionProps {
  children: React.ReactNode;
  title: string;
}

function Section({ title, children }: SectionProps) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

export function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-10 text-sm text-slate-700">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">About</h1>
        <p className="text-slate-600">
          This tool takes a list of drug names — brand names, generic INN names,
          or internal company codes — and resolves each one against a layered set
          of public APIs to determine its FDA approval status. It runs entirely
          in your browser; no data leaves your machine except to call the public
          APIs listed below.
        </p>
      </div>

      <Section title="Data flow">
        <p>
          Each name is run through a five-layer pipeline. The pipeline
          short-circuits as soon as an approved or discontinued record is
          confirmed, but every API call is recorded as a SourceHit so you can
          audit exactly how a result was reached (click the ▸ on any row).
        </p>
        <ol className="space-y-3 pl-0 list-none">
          {PIPELINE.map((step) => (
            <li
              key={step.n}
              className="flex gap-3 rounded-md ring-1 ring-slate-200 bg-white p-3"
            >
              <span className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-violet-100 text-violet-700 text-xs font-semibold">
                {step.n}
              </span>
              <div className="space-y-1">
                <div className="font-medium text-slate-900">{step.title}</div>
                <div className="text-slate-600">{step.detail}</div>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-xs text-slate-500">
          A 7-day localStorage cache (configurable) skips this pipeline entirely
          for repeat queries.
        </p>
      </Section>

      <Section title="Data sources">
        <ul className="space-y-3">
          {SOURCES.map((s) => (
            <li
              key={s.name}
              className="rounded-md ring-1 ring-slate-200 bg-white p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-violet-700 hover:underline"
                >
                  {s.name}
                </a>
                <span className="text-xs text-slate-500">{s.org}</span>
              </div>
              <p className="text-slate-600 mt-1">{s.role}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Technical implementation">
        <ul className="space-y-2 list-disc pl-5">
          <li>
            <span className="font-medium text-slate-900">React 18 + TypeScript + Vite</span>,
            built as a static SPA. No server-side code; deployable to GitHub
            Pages, Cloudflare Pages, or any static host.
          </li>
          <li>
            <span className="font-medium text-slate-900">Native fetch</span>{" "}
            for every API call. Tailwind for styling.{" "}
            <code className="text-xs bg-slate-100 px-1 rounded">useReducer</code>
            -free local state.
          </li>
          <li>
            <span className="font-medium text-slate-900">5-way concurrency</span>{" "}
            in the batch runner balances throughput against upstream rate
            limits. openFDA receives a single 2-second retry on HTTP 429.
          </li>
          <li>
            <span className="font-medium text-slate-900">CORS-aware design</span>:
            we evaluated NCI Thesaurus (no CORS — blocked from browsers) and
            picked ChEMBL instead. PubChem's substance endpoint also works but
            lacks ChEMBL's structured syn_type field.
          </li>
          <li>
            <span className="font-medium text-slate-900">Privacy</span>: API
            keys are stripped before being stored on SourceHit URLs, so the
            audit UI and CSV exports never contain credentials. Optional
            Google Analytics 4 events use a stable hash of the normalized name
            (no PHI).
          </li>
          <li>
            See{" "}
            <code className="text-xs bg-slate-100 px-1 rounded">
              fda-lookup-spec.md
            </code>{" "}
            in the repo for the full design spec, or{" "}
            <code className="text-xs bg-slate-100 px-1 rounded">
              CONTRIBUTING.md
            </code>{" "}
            to add a new layer or data source.
          </li>
        </ul>
      </Section>

      <Section title="Limitations">
        <ul className="space-y-2 list-disc pl-5">
          <li>
            <span className="font-medium">Not medical advice.</span> Treat
            approval status as a research aid and verify against the official
            FDA Drugs@FDA database before relying on it.
          </li>
          <li>
            ChEMBL's coverage is strong for approved drugs and well-known
            research codes, but very early-phase compounds may not be indexed.
          </li>
          <li>
            ClinicalTrials.gov INN extraction is heuristic. A drug-only-in-trials
            with no INN assigned will remain not_found.
          </li>
        </ul>
      </Section>
    </div>
  );
}
