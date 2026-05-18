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
    detail: "Runs brand-name and generic-name searches in parallel, then picks the higher-rank candidate (NDA/BLA preferred over ANDA) with the earliest approval date. Match acceptance is strict: brand_name exact match, or substance/generic exact (or salt-form) match on a single-ingredient product — this avoids combination-product mismatches like aspirin → Aggrenox. If the chosen application's products are all marked Discontinued but a sibling application for the same molecule is approved, the molecule is reported as approved while keeping the original application's identity (date, appnum) — that's the duloxetine / Xeloda pattern from #33.",
  },
  {
    n: 2,
    title: "openFDA /drug/label",
    detail: "Fallback for drugs that have a label but aren't in drugsfda. Matches when the label's marketing_category is NDA or BLA and openfda.application_number is present.",
  },
  {
    n: 3,
    title: "openFDA /drug/ndc",
    detail: "The National Drug Code directory covers products outside the NDA/BLA/ANDA path. Filtered to single-ingredient exact matches, we read marketing_category: OTC MONOGRAPH * → otc_monograph status, UNAPPROVED * → unapproved_marketed. This is how aspirin, acetaminophen, and similar pharmacy-shelf drugs get correct structured answers instead of misleading combination-product matches.",
  },
  {
    n: 4,
    title: "RxNorm",
    detail: "Resolve the input to an RxCUI, then query the FDA_APPLICATION_NUMBER property. If the value is prefixed NDA/BLA/ANDA, we have a hit.",
  },
  {
    n: 5,
    title: "ChEMBL",
    detail: "ID-to-INN translation when the earlier layers miss (e.g. internal codes like MEDI4736, AZD9291). We match against molecule_synonyms with syn_type='INN', then re-run layers 1-4 with the resolved INN.",
  },
  {
    n: 6,
    title: "ClinicalTrials.gov v2",
    detail: "Last resort. We scan top study results for interventions whose canonical name contains the query, then pick an INN-shaped otherName as the translated name and re-run layers 1-4.",
  },
  {
    n: 7,
    title: "LLM arbiter (Gemini via Vertex AI)",
    detail: "Runs on every resolved candidate AND when layers 1-6 came up empty. When the deterministic pipeline found a candidate, the arbiter receives it plus the candidate's current FDA label `indications_and_usage` text as grounding context, then either confirms the pipeline, corrects it with an earlier original approval (useful for drugs whose innovator NDA predates openFDA — Cosmegen 1964, Velban 1961, Cytosar-U 1969), or flags uncertainty. When nothing was resolved, the arbiter is asked blank-slate and its high-confidence answer becomes the result. It also extracts the verbatim current FDA-label indications and a best-guess original-approval indication. Proxied through a Netlify Function that authenticates to Vertex AI with a project-owned service account; no user-side LLM key is needed. The pipeline applies strict gates before accepting overrides (high confidence, ≥1 year earlier, same molecule, brand-equality for brand-specific queries).",
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
          of public APIs to determine its FDA approval status and the conditions
          it's currently approved to treat. It runs entirely in your browser;
          no data leaves your machine except to call the public APIs listed
          below (and the LLM arbiter proxy, when enabled).
        </p>
      </div>

      <Section title="What problem this solves">
        <p>
          Drugs@FDA is the authoritative source for "is this drug FDA approved?"
          but it's tedious to use at the scale of clinical research workflows —
          one name at a time, brand vs. generic confusion, no surface for
          research codes like MK-3475, and indication text buried in
          PDF-shaped labels. This app gives you a paste-a-list interface that
          unifies the six relevant public APIs plus an LLM arbiter, returns
          the canonical original-approval record per drug, and pulls the
          verbatim FDA-label indications out of the current label.
        </p>
      </Section>

      <Section title="Data flow">
        <p>
          Each name is run through a seven-layer pipeline. Layers 1-6
          short-circuit as soon as an approved or discontinued record is
          confirmed. Layer 7 (the LLM arbiter) then runs on every approved
          candidate to verify-or-correct against the current FDA label and
          to enumerate the label's indications. Every API call is recorded
          as a SourceHit, so you can audit exactly how a result was reached
          (click any row to open the detail panel).
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

      <Section title="Indications (current FDA label, verbatim)">
        <p>
          When the deterministic pipeline resolves a drug, the app fetches
          that application's current FDA label{" "}
          <code className="text-xs bg-slate-100 px-1 rounded">
            indications_and_usage
          </code>{" "}
          section and includes it in the arbiter prompt as grounding context.
          The arbiter then extracts two indication fields:
        </p>
        <ul className="space-y-2 list-disc pl-5">
          <li>
            <span className="font-medium text-slate-900">
              Current indications
            </span>{" "}
            — every distinct indication on the current label, returned
            verbatim. Biomarker requirements ("EGFR T790M mutation-positive"),
            lines of therapy, age cohorts, and combination partners are
            preserved exactly as the FDA wrote them. No taxonomy
            normalization (MeSH, EFO) — those distinctions are part of what
            the FDA approved.
          </li>
          <li>
            <span className="font-medium text-slate-900">
              Original indication
            </span>{" "}
            — best-effort first-approval indication, anchored to the
            candidate's approval date. This draws on the model's training
            knowledge since the current label often reflects only later
            supplements; it's marked with an "LLM" badge in the UI to
            signal that it's less rigorously grounded than the current list.
          </li>
        </ul>
        <p className="text-xs text-slate-500">
          The raw label text the arbiter saw is also surfaced in the detail
          panel (collapsed by default), so anyone doing serious work can
          read past the LLM-extracted list and verify against the canonical
          FDA Drugs@FDA label.
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
            for every API call. Tailwind for styling. Two-phase{" "}
            <code className="text-xs bg-slate-100 px-1 rounded">phase</code>{" "}
            state machine (input → results) keeps the dashboard layout
            without router overhead.
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
          <li>
            Current indications are pulled from the resolved application's
            current label only — withdrawn indications (e.g. Avastin in
            metastatic breast cancer, removed 2011) are not present.
            Drugs with multiple applications (oral and IV formulations,
            successor sponsors) yield indications from one canonical label.
          </li>
          <li>
            The original-approval indication relies on the model's training
            knowledge and is not authoritatively grounded; verify against
            the FDA approval history before citing it.
          </li>
        </ul>
      </Section>
    </div>
  );
}
