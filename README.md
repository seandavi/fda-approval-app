# FDA Drug Approval Lookup

A single-page web app for resolving a list of drug names — brand names, generic
INNs, or internal company codes like `MK-3475` — against a layered set of
public APIs to determine FDA approval status.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb.svg)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646cff.svg)](https://vitejs.dev/)

Runs entirely in the browser. No backend, no server-side storage. Deployable
to any static host (GitHub Pages, Cloudflare Pages, S3, …).

---

## Features

- **Five-layer lookup pipeline** — openFDA `drugsfda` → openFDA `label` →
  RxNorm → ChEMBL → ClinicalTrials.gov, short-circuiting on first hit.
- **ID translation** — internal codes (MK-3475, MEDI4736, AZD9291) are
  resolved to their INN via ChEMBL's structured synonym data, then re-run
  through the FDA layers.
- **Auditable** — every API call is recorded as a SourceHit and viewable
  inline per result, so misses are debuggable in seconds.
- **Batch input** — paste a list, get a sortable / filterable table.
- **CSV export** of all resolved fields.
- **Local cache** with 7-day TTL (configurable) keyed by normalized name.
- **Privacy-preserving** — openFDA API keys are redacted from stored URLs;
  optional GA4 events use a stable hash of the normalized name.

## Quick start

```sh
npm install
cp .env.example .env   # optional
npm run dev            # http://localhost:5173/fda-drug-lookup/
```

Both env vars are optional. The app works unauthenticated; openFDA just
limits you to 240 requests/min.

## Configuration

All env vars are read at build time via `import.meta.env`. You can override
the openFDA key at runtime through the **Settings** panel (persisted to
`localStorage`).

| Variable | Default | Purpose |
|---|---|---|
| `VITE_OPENFDA_API_KEY` | _empty_ | openFDA API key. Without one, traffic is rate limited per IP. Get a free key at [open.fda.gov](https://open.fda.gov/apis/authentication/). |
| `VITE_GA_MEASUREMENT_ID` | _empty_ | Google Analytics 4 measurement ID (`G-XXXXXXXXXX`). GA is skipped silently if blank. |
| `VITE_BATCH_LIMIT` | `100` | Hard cap on names per batch lookup. |

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

1. **Netlify → Site settings → Domain management → Add custom domain**;
   enter the subdomain (e.g. `fda.cancerdatasci.org`) and accept the
   verification step.
2. **Cloudflare DNS → Add record**: type `CNAME`, name `fda`, target
   `<your-site>.netlify.app`, **Proxy status: DNS only** (gray cloud).
   The "DNS only" toggle is important — Cloudflare proxy in front of
   Netlify breaks Netlify's automatic Let's Encrypt provisioning. Wait
   a few minutes; Netlify will detect the DNS record and issue a cert
   automatically.
3. Optional later: switch the record back to **Proxied** (orange cloud)
   for Cloudflare's CDN. Cloudflare SSL mode must be **Full (strict)**
   for that to work without warnings.

## Architecture

```
src/
  api/openfda.ts        layers 1 (drugsfda) and 2 (label)
  api/rxnorm.ts         layer 3
  api/chembl.ts         layer 4
  api/clinicaltrials.ts layer 5
  lookup.ts             orchestrates the pipeline with short-circuit
  cache.ts              localStorage result cache (7d default TTL)
  normalize.ts          name cleanup + INN heuristics
  analytics.ts          GA4 wrapper
  components/           InputPanel, ResultsTable, ResultRow, StatusBadge,
                        ProgressBar, ExportButton, SettingsPanel, AboutPage,
                        InfoTooltip
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
