import type { ApprovalStatus, SourceHit } from "../types";

const PROXY_URL = "/api/llm-lookup";

interface LLMResponseShape {
  status?: ApprovalStatus | "otc_monograph";
  brand_name?: string | null;
  generic_name?: string | null;
  application_number?: string | null;
  application_type?: "NDA" | "BLA" | "ANDA" | null;
  approval_date?: string | null;
  sponsor?: string | null;
  confidence?: "high" | "medium" | "low";
  rationale?: string;
}

export interface LLMPartial {
  status?: ApprovalStatus;
  brandName?: string;
  genericName?: string;
  applicationNumber?: string;
  applicationType?: "NDA" | "BLA" | "ANDA";
  approvalDate?: string;
  sponsor?: string;
  confidence?: "high" | "medium" | "low";
  rationale?: string;
  sources: SourceHit[];
}

export interface LLMOptions {
  // Whether the deployment runs the LLM-lookup function. Browser dev mode
  // (vite dev without `netlify dev`) has no proxy, so we don't bother
  // calling it; production builds enable this automatically.
  enableProxy: boolean;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // The function asks Vertex/Gemini for application/json output, but we
  // strip optional ```json fences defensively for robustness.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const payload = fenced ? fenced[1] : trimmed;
  return JSON.parse(payload);
}

function normalizeAppNum(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const m = raw.toUpperCase().replace(/\s+/g, "").match(/^(NDA|BLA|ANDA)0*(\d+)$/);
  if (!m) return raw.toUpperCase();
  return `${m[1]}${m[2].padStart(6, "0")}`;
}

function appTypeOf(num: string | undefined): "NDA" | "BLA" | "ANDA" | undefined {
  if (!num) return undefined;
  if (num.startsWith("BLA")) return "BLA";
  if (num.startsWith("ANDA")) return "ANDA";
  if (num.startsWith("NDA")) return "NDA";
  return undefined;
}

function mapStatus(s: string | undefined): ApprovalStatus | undefined {
  if (s === "approved" || s === "discontinued" || s === "not_found") return s;
  if (s === "otc_monograph") return "otc_monograph";
  return undefined;
}

interface ProxyMessage {
  content?: Array<{ type: string; text?: string }>;
}

export async function queryLLM(
  name: string,
  opts: LLMOptions
): Promise<LLMPartial> {
  const sources: SourceHit[] = [];
  const api = "llm/gemini";
  if (!opts.enableProxy) {
    return { sources };
  }
  const safeUrl = PROXY_URL;
  try {
    const r = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drugName: name }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      sources.push({
        api,
        url: safeUrl,
        hit: false,
        detail: `HTTP ${r.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
      });
      return { sources };
    }
    const body = (await r.json()) as { model?: string; message?: ProxyMessage };
    const text = (body.message?.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("");
    if (!text) {
      sources.push({ api, url: safeUrl, hit: false, detail: "empty response" });
      return { sources };
    }
    let parsed: LLMResponseShape;
    try {
      parsed = extractJson(text) as LLMResponseShape;
    } catch (e) {
      sources.push({
        api,
        url: safeUrl,
        hit: false,
        detail: `parse failed: ${e instanceof Error ? e.message : "unknown"}`,
      });
      return { sources };
    }
    const status = mapStatus(parsed.status);
    if (!status || status === "not_found") {
      sources.push({
        api,
        url: safeUrl,
        hit: false,
        detail: `status=${parsed.status ?? "?"} (conf=${parsed.confidence ?? "?"})`,
      });
      return {
        sources,
        confidence: parsed.confidence,
        rationale: parsed.rationale,
      };
    }
    // Treat "low" confidence as not actionable — many lookups for
    // nonexistent drugs return low-confidence guesses. Surface the
    // rationale via the source record so users can still see what the
    // model thought.
    if (parsed.confidence === "low") {
      sources.push({
        api,
        url: safeUrl,
        hit: false,
        detail: `low-confidence ${parsed.status} — ${parsed.rationale ?? ""}`.trim(),
      });
      return {
        sources,
        confidence: parsed.confidence,
        rationale: parsed.rationale,
      };
    }
    const appNum = normalizeAppNum(parsed.application_number ?? undefined);
    sources.push({
      api,
      url: safeUrl,
      hit: true,
      detail: `${parsed.status} ${appNum ?? ""} (${parsed.confidence ?? "?"})`.trim(),
    });
    return {
      status,
      brandName: parsed.brand_name ?? undefined,
      genericName: parsed.generic_name ?? undefined,
      applicationNumber: appNum,
      applicationType: parsed.application_type ?? appTypeOf(appNum),
      approvalDate: parsed.approval_date ?? undefined,
      sponsor: parsed.sponsor ?? undefined,
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      sources,
    };
  } catch (e) {
    sources.push({
      api,
      url: safeUrl,
      hit: false,
      detail: e instanceof Error ? e.message : "fetch failed",
    });
    return { sources };
  }
}
