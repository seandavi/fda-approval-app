import type { ApprovalStatus, SourceHit } from "../types";

const PROXY_URL = "/api/llm-lookup";

interface LLMResponseShape {
  agreement?: "confirm" | "correct" | "unknown";
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

export interface PipelineFinding {
  status?: ApprovalStatus;
  applicationNumber?: string;
  applicationType?: "NDA" | "BLA" | "ANDA";
  approvalDate?: string;
  brandName?: string;
  genericName?: string;
  resolvedVia?: string;
  // Current FDA label `indications_and_usage` text for the candidate, used
  // as semantic grounding for the arbiter. Omitted when no label was found.
  labelIndicationText?: string;
}

export interface LLMPartial {
  agreement?: "confirm" | "correct" | "unknown";
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
  // Deterministic-pipeline candidate sent to the model as a seed. With it,
  // the model verifies or corrects rather than reasoning blank-slate —
  // which dramatically cuts hallucination on otherwise-unanchored queries.
  pipelineFinding?: PipelineFinding;
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
      body: JSON.stringify({
        drugName: name,
        pipelineFinding: opts.pipelineFinding,
      }),
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
    const appNum = normalizeAppNum(parsed.application_number ?? undefined);
    const agreement = parsed.agreement ?? "unknown";
    sources.push({
      api,
      url: safeUrl,
      hit: !!status && status !== "not_found",
      detail: `${agreement} ${parsed.status ?? "?"} ${appNum ?? ""} (conf=${parsed.confidence ?? "?"})`.trim(),
    });
    // Always return the parsed payload so the resolver's override logic
    // can apply its own thresholds (confidence + date gap + same-molecule
    // check). Pre-filtering for confidence='low' here would hide useful
    // "the candidate is right" confirmations.
    return {
      agreement,
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
