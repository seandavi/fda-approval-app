# Contributing

Thanks for considering a contribution. This is a small static-site project; the
contribution loop is intentionally lightweight.

## Getting set up

```sh
git clone <fork-url>
cd fda-approval-app
npm install
cp .env.example .env   # optional: fill in keys for local dev
npm run dev
```

`npm run dev` starts Vite at http://localhost:5173 (or 5174 if 5173 is taken).
Hot reload is enabled.

## Repo layout

```
src/
  api/              one module per upstream API (openfda, rxnorm, chembl, clinicaltrials)
  components/       presentational React components (Tailwind, no UI lib)
  lookup.ts         orchestrates the 5-layer pipeline + 5-way batch concurrency
  cache.ts          localStorage result cache (7d default TTL)
  normalize.ts      input cleanup + INN/internal-ID heuristics
  analytics.ts      thin GA4 gtag wrapper
  types.ts          shared types: DrugResult, SourceHit, AppSettings
public/             static assets (favicon)
fda-lookup-spec.md  original product spec; refer to it for design intent
```

## How to add a new API layer

1. Create `src/api/<name>.ts` exporting a single `query<Name>(input, ...)`
   function. It must return `{ resolvedINN?, ..., sources: SourceHit[] }` and
   record one `SourceHit` per request attempted (success or failure).
2. Wire it into `src/lookup.ts` in the appropriate spot. If the new layer
   produces an FDA-relevant result directly, add it to the openFDA→RxNorm
   chain. If it's an ID-to-INN translator, add it to the fallback layers
   after ChEMBL.
3. Add a corresponding entry to `ResolvedVia` in `src/types.ts`.
4. Update the `Source` column tooltip in `src/components/ResultsTable.tsx`.
5. Document the layer in `src/components/AboutPage.tsx` (the `PIPELINE`
   array).
6. Update the README's Architecture section.

## Coding conventions

- **TypeScript strict mode.** `npm run build` runs the type checker; CI will
  fail on any error.
- **No unused vars.** `noUnusedLocals` and `noUnusedParameters` are on.
- **Use `fetch` directly.** Don't add axios or other HTTP libraries.
- **No state management library.** Local component state (`useState`) and
  prop drilling are fine at this scale.
- **Tailwind only** for styling. No CSS modules, styled-components, or
  global stylesheets beyond `src/index.css`.
- **Don't log API keys.** All openFDA URLs stored in SourceHit records run
  through `redact()` in `src/api/openfda.ts`.
- **Don't add comments that just restate code.** Reserve comments for the
  "why" — a hidden constraint, a subtle invariant, or a workaround.

## Testing

There's no automated test suite yet. Manual checks before opening a PR:

- `npm run build` must complete cleanly (type checker + Vite).
- Test a small batch in the dev server: at minimum a brand name (Keytruda),
  a generic name (pembrolizumab), an internal code (MK-3475), and a
  nonsense string. All four should resolve as expected.
- Open the in-row source detail (▸ on any row) and confirm no API key
  appears in stored URLs.

## Pull requests

- One topic per PR. If you're tempted to bundle a refactor with a bug fix,
  split it.
- Commit messages follow the convention `Verb subject` (imperative) with a
  short body explaining the *why*. See existing history for examples.
- Tag the issue if there is one.

## Reporting bugs

Open an issue with:

- The input you queried
- The expected result
- The actual result
- The "Source detail" rows from the expanded result row (these list every
  upstream API call we made and what it returned).

## Out of scope

- User accounts / persistent server-side storage
- Bulk file upload (planned for v2)
- A C2 proxy for rate-limit pooling

See `fda-lookup-spec.md` for the original scope statement.
