import { vi } from "vitest";

type JsonResponse = { status?: number; body: unknown };
type Matcher = (url: string) => JsonResponse | null;

export interface Call {
  url: string;
  body?: unknown;
}

// Routes are matched in registration order. A route matches if its URL fragment
// (a substring or regex) appears in the request URL — we don't need fully
// faithful URL parsing for the resolver tests, just enough to route by
// hostname + path + the query token we care about.
export class FetchMock {
  private routes: Matcher[] = [];
  private calls: Call[] = [];

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
    return this.calls.map((c) => c.url);
  }

  calls_(): Call[] {
    return [...this.calls];
  }

  // Returns the parsed JSON body of the first call whose URL matches the
  // fragment. Useful for asserting that request payloads contain the right
  // fields (e.g., that the LLM proxy received `labelIndicationText`).
  bodyOf(fragment: string | RegExp): unknown {
    const matcher =
      typeof fragment === "string"
        ? (u: string) => u.includes(fragment)
        : (u: string) => fragment.test(u);
    const c = this.calls.find((call) => matcher(call.url));
    return c?.body;
  }

  install(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const raw = typeof input === "string" ? input : input.toString();
        let parsedBody: unknown;
        if (init?.body && typeof init.body === "string") {
          try {
            parsedBody = JSON.parse(init.body);
          } catch {
            parsedBody = init.body;
          }
        }
        this.calls.push({ url: raw, body: parsedBody });
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
          JSON.stringify({ error: `unmatched fetch: ${raw}` }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      })
    );
  }
}
