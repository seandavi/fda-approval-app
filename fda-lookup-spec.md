# FDA Drug Approval Lookup — Claude Code Spec

## Project Overview

A single-page React + TypeScript + Vite app that takes a list of drug names
(brand names, generic/INN names, or early-phase internal IDs like `MK-3475`)
and resolves each one against a layered set of public APIs to determine FDA
approval status. Deployable as a static site to GitHub Pages or Cloudflare Pages.

---

## Tech Stack

- **Framework**: React 18 + TypeScript
- **Build**: Vite
- **Styling**: Tailwind CSS (utility-first, no component library)
- **HTTP**: native `fetch` (no Axios)
- **State**: React `useState` / `useReducer` — no Redux
- **Persistence**: `localStorage` for result caching (keyed by normalized name)
- **Analytics**: Google Analytics 4 (gtag.js)
- **Deployment target**: static site (no server-side code)

---

## Environment / Configuration

Create a `.env` file (and `.env.example` checked into git):

```
VITE_OPENFDA_API_KEY=        # optional but recommended; get at open.fda.gov
VITE_GA_MEASUREMENT_ID=      # e.g. G-XXXXXXXXXX
```

Both are injected at build time via `import.meta.env`. If `VITE_OPENFDA_API_KEY`
is empty, openFDA requests proceed unauthenticated (240 req/min limit).

---

## Core Data Model

```typescript
type ApprovalStatus =
  | "approved"          // found active NDA/BLA/ANDA with "AP" submission
  | "discontinued"      // approved but marketing_status = Discontinued
  | "not_found"         // no FDA record found after all layers
  | "pending"           // lookup in progress
  | "error";            // network/parse error

interface DrugResult {
  inputName: string;           // raw user input
  normalizedName: string;      // cleaned for querying
  resolvedINN?: string;        // if input was an internal ID, the INN found
  resolvedVia?: string;        // "openfda_brand" | "openfda_generic" | "rxnorm" | "nci" | "clinicaltrials"
  status: ApprovalStatus;
  applicationNumber?: string;  // e.g. "NDA761069"
  applicationType?: string;    // "NDA" | "BLA" | "ANDA"
  brandName?: string;
  genericName?: string;
  approvalDate?: string;
  sponsor?: string;
  sources: SourceHit[];        // all API responses that contributed
  cached: boolean;
  lookedUpAt: string;          // ISO timestamp
}

interface SourceHit {
  api: string;
  url: string;
  hit: boolean;
  detail?: string;
}
```

---

## Lookup Pipeline

Execute layers in order; short-circuit as soon as `status = "approved"` or
`"discontinued"` is confirmed. Collect all `SourceHit` records regardless.

### Layer 1 — openFDA `/drug/drugsfda` (most authoritative)

Try both brand name and generic name fields:

```
GET https://api.fda.gov/drug/drugsfda.json
  ?search=openfda.brand_name:"<NAME>"&limit=5&api_key=<KEY>

GET https://api.fda.gov/drug/drugsfda.json
  ?search=openfda.generic_name:"<NAME>"&limit=5&api_key=<KEY>
```

For each result, scan `submissions[]` for any entry where
`submission_status === "AP"`. If found → `status = "approved"`.
If found but all products have `marketing_status === "Discontinued"` →
`status = "discontinued"`.

Also try a wildcard if exact match fails:
```
search=openfda.generic_name:"<NAME>*"
```

### Layer 2 — openFDA `/drug/label`

Fallback for drugs that have a label but may not be in drugsfda:
```
GET https://api.fda.gov/drug/label.json
  ?search=openfda.brand_name:"<NAME>"&limit=3
```
Check `openfda.application_number` — if it starts with `NDA`, `BLA`, or `ANDA`
and the label's `marketing_category` is `"NDA"` or `"BLA"`, treat as approved.

### Layer 3 — RxNorm (NLM)

Useful for INN → rxcui → FDA application number:
```
GET https://rxnav.nlm.nih.gov/REST/drugs.json?name=<NAME>
```
Extract `rxcui`, then:
```
GET https://rxnav.nlm.nih.gov/REST/rxcui/<rxcui>/property.json
  ?propName=FDA_APPLICATION_NUMBER
```
If property value starts with `NDA`/`BLA`/`ANDA` → approved.

### Layer 4 — NCI Thesaurus (EVS)

Best for internal IDs (`MK-3475`, `MEDI4736`, NCI codes like `C-XXXXX`):
```
GET https://api-evsrest.nci.nih.gov/api/v1/concept/ncit/search
  ?term=<NAME>&type=contains&pageSize=5
```
Extract the preferred INN from the concept's `synonyms` where
`termType === "PT"` (preferred term) or look for FDA-preferred terms.
Store this as `resolvedINN` and re-run layers 1–3 with it.

### Layer 5 — ClinicalTrials.gov v2

Last resort for pipeline-to-INN mapping:
```
GET https://clinicaltrials.gov/api/v2/studies
  ?query.intr=<NAME>
  &fields=InterventionName,InterventionOtherName
  &pageSize=5
```
Scan `InterventionOtherName` for an INN (heuristic: prefer entries that look
like INNs — all lowercase, no numbers). Store as `resolvedINN` and re-run
layers 1–3.

### Normalization (pre-query)

Before querying, normalize the input:
- Strip `®`, `™`, `©`
- Trim whitespace
- Lowercase for generic-name queries
- Remove common suffixes like `" injection"`, `" tablets"`, `" hcl"` for
  initial queries (retry with them if first pass fails)

---

## Caching

- Key: `fda_lookup_v1_<normalizedName>` in `localStorage`
- Value: serialized `DrugResult`
- TTL: 7 days (check `lookedUpAt`)
- Show a small "cached" badge on cached results
- Provide a "Clear cache" button in settings

---

## UI Requirements

### Input Panel

- Large textarea for **batch input**: one drug name per line (or comma-separated)
- OR a single search box for interactive one-at-a-time lookup
- Toggle between modes
- "Lookup" button — disabled while any request is in flight
- Show character/line count

### Results Table

Columns: Input Name | Resolved As | Status | App # | Type | Brand | Sponsor | Source

- Color-coded status badges:
  - `approved` → green
  - `discontinued` → amber
  - `not_found` → red
  - `error` → gray
- Expandable row showing all `SourceHit` records (which APIs were tried)
- Sort by any column
- Filter by status

### Export

- "Download CSV" button — exports all results
- CSV columns: inputName, resolvedINN, status, applicationNumber, applicationType,
  brandName, genericName, approvalDate, sponsor, resolvedVia, lookedUpAt

### Settings Panel (collapsible)

- openFDA API key input (stored in localStorage, not env)
- GA Measurement ID override
- Cache TTL setting
- Toggle: show/hide source detail by default

### Progress

- During batch lookup: progress bar (`X of Y complete`) 
- Per-row spinner while pending
- Concurrency: process **5 lookups in parallel** max (to respect rate limits)

---

## Google Analytics 4 Instrumentation

Load gtag.js in `index.html`:
```html
<script async src="https://www.googletagmanager.com/gtag/js?id=${VITE_GA_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${VITE_GA_MEASUREMENT_ID}');
</script>
```

Create a `src/analytics.ts` module:

```typescript
export function trackEvent(
  eventName: string,
  params?: Record<string, string | number | boolean>
) {
  if (typeof window.gtag === "function") {
    window.gtag("event", eventName, params);
  }
}
```

Instrument the following events:

| Event Name | When | Parameters |
|---|---|---|
| `lookup_started` | User clicks Lookup | `{ batch_size: number, mode: "single"\|"batch" }` |
| `lookup_completed` | All results resolved | `{ batch_size, approved_count, not_found_count, error_count, duration_ms }` |
| `drug_resolved` | Single drug result | `{ status, resolved_via, was_cached, had_id_translation: boolean }` |
| `export_csv` | User downloads CSV | `{ row_count }` |
| `cache_cleared` | User clears cache | — |
| `api_key_set` | User saves API key | — |
| `layer_hit` | A lookup layer returned a result | `{ layer: 1\|2\|3\|4\|5, drug_name_hash: string }` |

Use a stable hash (e.g. `btoa(normalizedName).slice(0,8)`) for `drug_name_hash`
so you can see which drugs cause the most layer-5 fallbacks without logging PII.

---

## Error Handling

- Per-drug: catch fetch errors, set `status = "error"`, store error message in `SourceHit.detail`
- Global: if openFDA returns 429 (rate limit), back off 2s and retry once
- If `VITE_GA_MEASUREMENT_ID` is empty, skip GA silently (no console warnings)
- If localStorage is unavailable (private browsing), disable caching silently

---

## Project Structure

```
fda-drug-lookup/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── .env.example
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── analytics.ts
│   ├── cache.ts
│   ├── normalize.ts
│   ├── types.ts
│   ├── api/
│   │   ├── openfda.ts       # layers 1 & 2
│   │   ├── rxnorm.ts        # layer 3
│   │   ├── nci.ts           # layer 4
│   │   └── clinicaltrials.ts # layer 5
│   ├── lookup.ts            # orchestrates the pipeline
│   └── components/
│       ├── InputPanel.tsx
│       ├── ResultsTable.tsx
│       ├── ResultRow.tsx
│       ├── StatusBadge.tsx
│       ├── ProgressBar.tsx
│       ├── ExportButton.tsx
│       └── SettingsPanel.tsx
```

---

## Deployment

Add a `deploy` script in `package.json` using `gh-pages`:
```json
"scripts": {
  "build": "vite build",
  "deploy": "vite build && gh-pages -d dist"
}
```

Add `base: '/fda-drug-lookup/'` to `vite.config.ts` for GitHub Pages subpath.
Document Cloudflare Pages as alternative (just point to `dist/`, no config needed).

---

## Out of Scope (v1)

- User accounts / persistent server-side storage
- Claude API integration (add later if ClinicalTrials layer is insufficient)
- HTTPS proxy for rate-limit pooling
- Bulk file upload (CSV/Excel input) — nice to have for v2
