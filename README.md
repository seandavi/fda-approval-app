# FDA Drug Approval Lookup

A single-page web app for resolving a list of drug names — brand names, generic
INNs, or internal company codes like `MK-3475` — against a layered set of
public APIs to determine FDA approval status, original approval date, and
the verbatim indications on the current FDA label.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb.svg)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646cff.svg)](https://vitejs.dev/)

**Live demo**: [fda-approvals.cancerdatasci.org](https://fda-approvals.cancerdatasci.org)

The frontend runs entirely in the browser. A single optional Netlify
Function proxies the LLM arbiter (Layer 7) so users don't need their own
LLM API key; with that disabled, the app remains a pure static site
deployable to any host (the deterministic layers 1-6 still resolve the
vast majority of drugs).

---

## Features

- **Seven-layer lookup pipeline** — openFDA `drugsfda` → openFDA `label` →
  openFDA `ndc` → RxNorm → ChEMBL → ClinicalTrials.gov → Gemini arbiter
  (Vertex AI). Layers 1-6 short-circuit on first hit. Layer 7 verifies the
  candidate against the current FDA label and either confirms, corrects
  with an earlier original approval, or flags uncertainty.
- **Indications (current FDA label, verbatim)** — Layer 7 also extracts
  every indication from the resolved label exactly as written, including
  biomarker requirements, lines of therapy, and combination partners. No
  taxonomy normalization — those distinctions are part of what the FDA
  approved.
- **Beyond NDA/BLA/ANDA** — the NDC layer captures drugs marketed under
  the FDA OTC monograph (aspirin, ibuprofen, acetaminophen) and those
  marketed without approval (homeopathic, etc.), with explicit status
  values rather than misleading "approved" / "not_found" answers.
- **ID translation** — internal codes (MK-3475, MEDI4736, AZD9291) are
  resolved to their INN via ChEMBL's structured synonym data, then re-run
  through the FDA layers.
- **Auditable** — every API call is recorded as a SourceHit and visible
  in the per-drug detail panel, so misses are debuggable in seconds.
- **Two-phase UI** — landing page with the gap statement, a workflow
  strip, and the input controls; submit moves to a results page with a
  dense table + sticky master-detail panel. "Edit input" returns to the
  landing page with the batch preserved.
- **Batch input** — paste a list (capped at `VITE_BATCH_LIMIT`, default 100),
  get a sortable / filterable table.
- **CSV export** of all resolved fields, including `originalIndication`
  and pipe-delimited `currentIndications`. Always-quote RFC 4180 + UTF-8
  BOM + CRLF makes it open cleanly in Excel on Windows.
- **Local cache** with 7-day TTL (configurable) keyed by normalized name.
- **In-app feedback** — header **Feedback** link and a per-result
  **Report** action open pre-filled GitHub issues (with the full SourceHit
  trail for wrong-result reports). One-click for users with a GitHub
  account.
- **Built-in About page** — data flow, indication extraction, data
  sources, and technical implementation are documented inside the app,
  not just in the README.
- **Privacy-preserving** — openFDA API keys are redacted from stored URLs;
  optional GA4 events use a stable hash of the normalized name.

## Quick start

```sh
npm install
cp .env.example .env   # optional
npm run dev            # http://localhost:5173
```

All env vars are optional. The app works unauthenticated; openFDA just
limits you to 240 requests/min.

## Configuration

All env vars are read at build time via `import.meta.env`. You can override
the openFDA key at runtime through the **Settings** panel (persisted to
`localStorage`).

| Variable | Default | Purpose |
|---|---|---|
| `VITE_OPENFDA_API_KEY` | _empty_ | openFDA API key. Without one, traffic is rate limited per IP. Get a free key at [open.fda.gov](https://open.fda.gov/apis/authentication/). |
| `VITE_GA_MEASUREMENT_ID` | _empty_ | Google Analytics 4 measurement ID (`G-XXXXXXXXXX`). GA is skipped silently if blank. See [Analytics](#analytics) below. |
| `VITE_BATCH_LIMIT` | `100` | Hard cap on names per batch lookup. |
| `VITE_GITHUB_REPO` | `seandavi/fda-approval-app` | Target repo for in-app feedback / report links. Forks should override this. |
| `VITE_BASE_PATH` | `/` | URL base path. Leave default for Netlify / Cloudflare Pages / custom domain; set to `/<repo-name>/` for GitHub Pages project pages. |

## Build & deploy

```sh
npm run build       # → ./dist
npm run preview     # local preview of the production build
```

Vite's `base` path is controlled by `VITE_BASE_PATH` at build time:

- Unset (default `/`) — for Netlify, Cloudflare Pages, or any custom domain.
- `/<repo-name>/` — for GitHub Pages project pages.

### Netlify (recommended)

1. Push the repo to GitHub.
2. At [app.netlify.com](https://app.netlify.com), **Add new site → Import an
   existing project → GitHub → fda-approval-app**.
3. The `netlify.toml` in the repo picks up the build command, publish dir,
   Node version, SPA redirect, and cache headers automatically. Skip the
   advanced UI fields.
4. **Site settings → Environment variables**: add
   `VITE_OPENFDA_API_KEY` (and `VITE_GA_MEASUREMENT_ID` if you have one)
   so the build picks them up.
5. Deploy.

You'll get a `*.netlify.app` URL plus a fresh preview deploy on every PR.

#### Optional: enable the Layer 7 LLM arbiter

The `/api/llm-lookup` Netlify Function in [`netlify/functions/`](netlify/functions/llm-lookup.ts)
calls Gemini via Vertex AI to:

1. Verify the deterministic pipeline's result against the candidate's
   current FDA label `indications_and_usage` text (catches wrong-molecule
   resolutions like aspirin → Aggrenox).
2. Correct the result when the original innovator NDA predates openFDA's
   online window (Cosmegen 1964, Velban 1961, Cytosar-U 1969, etc.).
3. Extract the verbatim current indications + a best-guess original-approval
   indication.

Without it, drugs whose innovator NDA is missing from openFDA return a
much later ANDA date, and the per-drug detail panel shows no indications.

Setup (one-time):

```sh
# Provisions GCP project, service account, role binding, and JSON key.
# Idempotent — re-running is a no-op if everything's already in place.
./scripts/setup-gcp.sh
```

The script writes the service-account JSON to `./secrets/` (gitignored).
Paste its contents into Netlify under **Site settings → Environment
variables**:

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | yes | — | Full service-account JSON, stringified. Without this the function returns 503 and Layer 7 is a quiet no-op. |
| `GCP_PROJECT_ID` | no | parsed from JSON | Override if the JSON's `project_id` isn't the one you want billed. |
| `VERTEX_REGION` | no | `global` | Gemini 3.x only lives at the global endpoint. |
| `VERTEX_MODEL` | no | `gemini-3.1-flash-lite` | Bump to `gemini-3.1-pro-preview` for harder cases. |

Smoke-test once deployed:

```sh
curl -s -X POST https://<your-site>/api/llm-lookup \
     -H 'content-type: application/json' \
     -d '{"drugName":"Cosmegen"}' | jq
```

Cost is on the order of a few cents per thousand lookups at Flash-Lite
pricing. **Set a GCP billing budget alert anyway** — the per-IP rate
limiter in the function is best-effort and resets on cold start; it isn't
a defense against a determined caller. The function also caps
`max_output_tokens` and ignores client-supplied model overrides.

### Cloudflare Pages

Same flow as Netlify, but at [dash.cloudflare.com](https://dash.cloudflare.com)
→ **Pages → Create a project → Connect to Git**. Build command
`npm run build`, output directory `dist`, Node version `20`. Add the env
vars in the Pages project settings.

### GitHub Pages

Subpath-only — the deployed site lives at `<user>.github.io/fda-approval-app/`.

```sh
npm run deploy:ghpages
```

This sets `VITE_BASE_PATH=/fda-drug-lookup/` for the build and publishes
`dist/` to the `gh-pages` branch via the `gh-pages` npm package. Update the
path segment in `package.json` if your repo name differs.

### Custom domain (Netlify + Cloudflare DNS)

Walkthrough for the current production deploy (`fda-approvals.cancerdatasci.org`);
substitute your own subdomain.

1. **Netlify → Site configuration → Domain management → Add a domain you
   already own** — enter the subdomain (e.g. `fda-approvals.cancerdatasci.org`).
   Netlify routes by `Host` header, so this step is what makes it actually
   serve at that name.
2. **Cloudflare DNS → Add record**: type `CNAME`, name `fda-approvals`,
   target `<your-site>.netlify.app`, **Proxy status: DNS only** (gray
   cloud). The "DNS only" toggle is important — Cloudflare proxy in
   front of Netlify breaks Netlify's automatic Let's Encrypt
   provisioning. Wait a few minutes; Netlify will detect the DNS record
   and issue a cert automatically.
3. Optional later: switch the record back to **Proxied** (orange cloud)
   for Cloudflare's CDN. Cloudflare SSL mode must be **Full (strict)**
   for that to work without warnings.

## Analytics

Optional. Create a GA4 property (one per site), add a Web data stream
pointed at your deploy URL, and copy the **Measurement ID**
(`G-XXXXXXXXXX`) into `VITE_GA_MEASUREMENT_ID` on Netlify. Trigger a
redeploy so the build picks it up.

`gtag.js` is loaded conditionally in `index.html` — if the env var is
empty, no Google scripts are fetched.

The app fires these custom events out of the box (see `src/lookup.ts`):

| Event | When | Notable params |
|---|---|---|
| `lookup_started` | Lookup button clicked | `batch_size`, `mode` |
| `lookup_completed` | Batch finishes | `batch_size`, `approved_count`, `not_found_count`, `error_count`, `duration_ms` |
| `drug_resolved` | Each individual result lands | `status`, `resolved_via`, `was_cached`, `had_id_translation` |
| `layer_hit` | A pipeline layer produces a hit | `layer` (1-7), `drug_name_hash` |
| `export_csv` / `cache_cleared` / `api_key_set` | UI actions | — |

Drug names are hashed (`btoa(normalized).slice(0,8)`) before being attached
to events, so reports surface aggregate patterns without storing PII.

## Architecture

```
src/
  api/openfda.ts        layers 1 (drugsfda), 2 (label), and label-by-appnum
                        fetch used as arbiter grounding
  api/ndc.ts            layer 3 (NDC directory — OTC monograph, unapproved-marketed)
  api/rxnorm.ts         layer 4
  api/chembl.ts         layer 5
  api/clinicaltrials.ts layer 6
  api/llm.ts            layer 7 client — POSTs to /api/llm-lookup
  lookup.ts             orchestrates the pipeline, runs the arbiter
  cache.ts              localStorage result cache (7d default TTL)
  csv.ts                RFC 4180 always-quote, UTF-8 BOM, CRLF CSV writer
  normalize.ts          name cleanup + INN heuristics
  analytics.ts          GA4 wrapper
  feedback.ts           builds pre-filled GitHub issue URLs for in-app feedback
  components/           LandingPage (gap statement + workflow strip + input),
                        ResultsPage (table + master-detail panel),
                        DetailPanel, ResultsTable, ResultRow,
                        ResultsStrip, StatusBadge, ProgressBar,
                        ExportButton, SettingsPanel, InputPanel,
                        AboutPage, InfoTooltip

netlify/
  functions/llm-lookup.ts  Vertex AI proxy. Holds the service-account
                           credential; client never sees an LLM key.
                           Receives the candidate + its label indication
                           text and asks the model to confirm/correct +
                           enumerate current indications.
scripts/
  setup-gcp.sh             Idempotent GCP project / SA / key bootstrap.
```

### Data flow

```
                      ┌──────────────────────────────────┐
                      │       Browser (Vite SPA)         │
                      │ ┌──────────────────────────────┐ │
                      │ │ lookup.ts                    │ │── openFDA, RxNorm,
                      │ │  Layers 1-6 (deterministic)  │ │   ChEMBL, CT.gov
                      │ └──────────────────────────────┘ │
                      │              │ resolved appNum   │
                      │              ▼                   │
                      │ ┌──────────────────────────────┐ │
                      │ │ fetchLabelIndicationByAppNum │ │── openFDA /drug/label
                      │ │   indications_and_usage      │ │
                      │ └──────────────────────────────┘ │
                      │              │                   │
                      │              ▼                   │
                      │ ┌──────────────────────────────┐ │
                      │ │ llm.ts (Layer 7 client)      │ │── POST /api/llm-lookup
                      │ │   sends candidate + label    │ │            │
                      │ └──────────────────────────────┘ │            │
                      └──────────────────────────────────┘            │
                                                                      │
                            same origin (Netlify)                     ▼
                      ┌─────────────────────────────────────────────────┐
                      │        Netlify Function: llm-lookup.ts          │
                      │ • Service account auth (env: GOOGLE_APP…JSON)   │
                      │ • Rate limit (per IP, token bucket)             │
                      │ • Truncates label text to MAX_LABEL_CHARS       │
                      │ • Caps: max_tokens, drug-name length            │
                      │ • Returns: confirm/correct/unknown + current    │
                      │   and original indications, all verbatim from   │
                      │   the label we provided                         │
                      └─────────────────────────────────────────────────┘
                                          │
                                          ▼
                              Google Vertex AI / Gemini
```

For the full design rationale, see [`fda-lookup-spec.md`](fda-lookup-spec.md)
or open the **About** view in the running app.

## Contributing

Issues and PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup
notes, conventions, and a short guide to adding a new API layer.

## Data attribution

- [openFDA](https://open.fda.gov/) — U.S. Food and Drug Administration
- [RxNorm](https://www.nlm.nih.gov/research/umls/rxnorm/) — U.S. National
  Library of Medicine
- [ChEMBL](https://www.ebi.ac.uk/chembl/) — EMBL-EBI
- [ClinicalTrials.gov](https://clinicaltrials.gov/) — U.S. National
  Library of Medicine

This project is independent and not affiliated with or endorsed by any of
these organizations.

## License

[MIT](LICENSE) © 2026 Sean Davis
