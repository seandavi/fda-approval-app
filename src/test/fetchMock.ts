import { vi } from "vitest";

type JsonResponse = { status?: number; body: unknown };
type Matcher = (url: string) => JsonResponse | null;

// Routes are matched in registration order. A route matches if its URL fragment
// (a substring or regex) appears in the request URL — we don't need fully
// faithful URL parsing for the resolver tests, just enough to route by
// hostname + path + the query token we care about.
export class FetchMock {
  private routes: Matcher[] = [];
  private calls: string[] = [];

  on(fragment: string | RegExp, response: JsonResponse | unknown): this {
    const fullResponse: JsonResponse =
      response && typeof response === "object" && "body" in (response as object)
        ? (response as JsonResponse)
        : { body: response };
    this.routes.push((url) => {
      if (typeof fragment === "string") {
        return url.includes(fragment) ? fullResponse : null;
      }
      return fragment.test(url) ? fullResponse : null;
    });
    return this;
  }

  notFound(fragment: string | RegExp): this {
    return this.on(fragment, { status: 404, body: { error: "not found" } });
  }

  calledUrls(): string[] {
    return [...this.calls];
  }

  install(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const raw = typeof input === "string" ? input : input.toString();
        this.calls.push(raw);
        // Route matching is more useful against the decoded form — tests
        // can write `brand_name:"aspirin"` instead of `brand_name%3A%22...`.
        let decoded = raw;
        try {
          decoded = decodeURIComponent(raw);
        } catch {
          decoded = raw;
        }
        const candidates = [decoded, raw];
        for (const route of this.routes) {
          const hit =
            candidates.map((u) => route(u)).find((h) => h !== null) ?? null;
          if (hit) {
            const status = hit.status ?? 200;
            const body = JSON.stringify(hit.body);
            return new Response(body, {
              status,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        return new Response(
          JSON.stringify({ error: `unmatched fetch: ${url}` }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      })
    );
  }
}
