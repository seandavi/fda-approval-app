import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithBackoff } from "./_http";

describe("fetchWithBackoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries once on HTTP 429, then returns the second response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithBackoff("https://x.example/y");
    // Advance past the 2s backoff.
    await vi.advanceTimersByTimeAsync(2000);
    const r = await promise;

    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-429 errors (returns the original response)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchWithBackoff("https://x.example/y");

    expect(r.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a second 429 — surfaces it as-is", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithBackoff("https://x.example/y");
    await vi.advanceTimersByTimeAsync(2000);
    const r = await promise;

    expect(r.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates init options on the retry call", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const init: RequestInit = { method: "POST", body: '{"x":1}' };
    const promise = fetchWithBackoff("https://x.example/y", init);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://x.example/y", init);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://x.example/y", init);
  });
});
