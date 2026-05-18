// Shared HTTP helpers for the API layers.
//
// Before this module existed (#30), `fetchWithBackoff` lived in both
// openfda.ts and ndc.ts as duplicate definitions, while rxnorm.ts,
// chembl.ts, and clinicaltrials.ts used bare `fetch` — a single 429
// from NLM/EBI/CT.gov would silently produce a not-found. Now every
// layer goes through the same code path with the same 429 retry policy.

// Single retry on HTTP 429, with a 2-second linear backoff. A second 429
// surfaces as-is rather than triggering exponential backoff: at our batch
// concurrency (5) and per-IP rate budgets (e.g. openFDA's 240 rpm anon),
// a second 429 means the user is doing something the upstream genuinely
// doesn't want us to do, and we shouldn't make it worse with retries.
export async function fetchWithBackoff(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const r = await fetch(url, init);
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 2000));
    return fetch(url, init);
  }
  return r;
}

// Strip api_key from a URL before recording it on a SourceHit (which is
// rendered to the UI and exported to CSV). No-op for URLs that don't
// carry an api_key query parameter — safe to call on every layer's URL.
export function redactApiKey(url: string): string {
  return url.replace(/([?&]api_key=)[^&]*/i, "$1REDACTED");
}
