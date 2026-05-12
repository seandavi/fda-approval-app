# FDA Drug Approval Lookup

Single-page React + TypeScript + Vite app that resolves drug names against
openFDA, RxNorm, NCI Thesaurus, and ClinicalTrials.gov to determine FDA
approval status. See `fda-lookup-spec.md` for the full spec.

## Local development

```sh
npm install
cp .env.example .env   # optional: fill in VITE_OPENFDA_API_KEY / VITE_GA_MEASUREMENT_ID
npm run dev
```

Both env vars are optional. Without `VITE_OPENFDA_API_KEY`, openFDA is rate
limited to 240 requests/min. Without `VITE_GA_MEASUREMENT_ID`, GA is skipped
silently.

You can also set the openFDA key at runtime via the in-app **Settings** panel
— that value is stored in `localStorage` and overrides the build-time env.

## Build

```sh
npm run build       # outputs to ./dist
npm run preview     # local preview of the production build
```

## Deploy

### GitHub Pages

The Vite config sets `base: '/fda-drug-lookup/'` to match a GitHub Pages
project path. Push this to a repo named `fda-drug-lookup` and run:

```sh
npm run deploy
```

This builds and publishes `dist/` to the `gh-pages` branch via the `gh-pages`
package. (If you host at a different path, update `base` in `vite.config.ts`.)

### Cloudflare Pages

Cloudflare Pages serves `dist/` from the root, so no `base` change is needed
for that target — set it to `'/'` in `vite.config.ts` before building if you
deploy only to Cloudflare. Build command `npm run build`, output directory
`dist`.

## Layout

```
src/
  api/openfda.ts        layers 1 (drugsfda) and 2 (label)
  api/rxnorm.ts         layer 3
  api/nci.ts            layer 4
  api/clinicaltrials.ts layer 5
  lookup.ts             orchestrates the pipeline with short-circuit
  cache.ts              localStorage result cache (7d default TTL)
  normalize.ts          name cleanup + heuristics
  analytics.ts          GA4 wrapper
  components/           InputPanel, ResultsTable, ResultRow, StatusBadge,
                        ProgressBar, ExportButton, SettingsPanel
```
