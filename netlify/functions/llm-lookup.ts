// Netlify Function: server-side LLM proxy for FDA drug-approval lookup.
//
// Why a backend at all: the LLM fallback (issue #13) needs Gemini access.
// Asking each user to bring their own API key is a non-starter for the
// actual audience (clinicians/research staff at CU Anschutz). This function
// calls Gemini via Vertex AI using a project-owned service account, so the
// LLM fallback "just works" for any visitor.
//
// Required Netlify env vars:
//   GOOGLE_APPLICATION_CREDENTIALS_JSON  -- full service account JSON (stringified)
// Optional:
//   GCP_PROJECT_ID    -- Vertex project (defaults to project_id from the JSON)
//   VERTEX_REGION     -- default "global" (Gemini 3.x only lives at the global endpoint)
//   VERTEX_MODEL      -- default "gemini-3.1-flash-lite"
//                        Bump to gemini-3.1-pro-preview / future GA via env var.
//
// Cost controls baked in:
//   - max_output_tokens hard-capped server-side.
//   - model overrides from the client are ignored — the server picks.
//   - per-IP token-bucket rate limit (best-effort; resets on cold-start).

import { GoogleGenAI, type Content } from "@google/genai";

const DEFAULT_REGION = process.env.VERTEX_REGION ?? "global";
const DEFAULT_MODEL = process.env.VERTEX_MODEL ?? "gemini-3.1-flash-lite";
// Gemini 3 preview uses ~thinking tokens, so it needs headroom even when
// the final answer is a tiny JSON object. Bumped from 2048 to make room
// for prompts that now include up to MAX_LABEL_CHARS of label text plus
// any thinking-token overhead on longer reasoning chains.
const MAX_TOKENS = 3072;
const MAX_DRUG_NAME_LEN = 200;
// Cap on label `indications_and_usage` text included in the prompt.
// Real labels for big-tent oncology drugs (Keytruda, Opdivo) run 15-20 KB,
// which is fine for Gemini's context window but costs latency. 24 KB lets
// even the largest current labels through intact while keeping a ceiling
// against runaway payloads.
const MAX_LABEL_CHARS = 24_000;

const SYSTEM_PROMPT =
  "You are an FDA drug-approval lookup assistant for clinicians and " +
  "researchers. Given a drug name (brand, generic, or internal code), return " +
  "the *original* FDA approval record — the first time the active ingredient " +
  "was approved by FDA, not a later supplement, biosimilar, or generic ANDA. " +
  "If the drug is OTC under a monograph (e.g. acetaminophen/Tylenol), say so. " +
  "If you are not confident, say so via the confidence field — do NOT " +
  "fabricate application numbers or dates. Respond with ONLY a single JSON " +
  "object, no prose, no markdown fencing.";

interface PipelineFinding {
  status?: string;
  applicationNumber?: string;
  applicationType?: string;
  approvalDate?: string;
  brandName?: string;
  genericName?: string;
  resolvedVia?: string;
  // Current FDA label `indications_and_usage` text for the candidate, used
  // as semantic grounding. Truncated server-side to MAX_LABEL_CHARS as a
  // belt-and-suspenders against pathological client payloads.
  labelIndicationText?: string;
}

function userPrompt(name: string, pipeline?: PipelineFinding): string {
  const base = `Look up the original FDA approval for: ${JSON.stringify(name)}.\n\n`;

  // When the deterministic pipeline already has a candidate, give it to
  // the model as a seed. The model's job is to confirm OR override with a
  // meaningfully earlier original. This is the "verifier" pattern — the
  // model has way less room to hallucinate when grounded in a concrete
  // proposal vs. asked blank-slate.
  const context = pipeline
    ? `Our deterministic resolver (openFDA + RxNorm + ChEMBL) returned this ` +
      `candidate. openFDA's online dataset is incomplete for many ` +
      `pre-2000 NDAs, so the earliest visible record is sometimes a later ` +
      `ANDA or reformulation rather than the original innovator NDA.\n` +
      `  status:             ${pipeline.status ?? "unknown"}\n` +
      `  application_number: ${pipeline.applicationNumber ?? "(none)"}\n` +
      `  application_type:   ${pipeline.applicationType ?? "(none)"}\n` +
      `  approval_date:      ${pipeline.approvalDate ?? "(none)"}\n` +
      `  brand_name:         ${pipeline.brandName ?? "(none)"}\n` +
      `  generic_name:       ${pipeline.genericName ?? "(none)"}\n` +
      `  resolved_via:       ${pipeline.resolvedVia ?? "(none)"}\n\n` +
      `Set "agreement" to "confirm" when this candidate IS the original ` +
      `FDA approval for the active ingredient. Set "correct" when you ` +
      `know of a meaningfully earlier original approval for the same ` +
      `molecule that's missing from the dataset — fill in that earlier ` +
      `record. Set "unknown" if you're not sure. Don't override a ` +
      `correct candidate with a hallucinated earlier one — only correct ` +
      `when the earlier date is well-attested.\n\n`
    : `No deterministic candidate was found. Set "agreement" to ` +
      `"unknown" and provide your best answer for the original approval.\n\n`;

  // Label grounding block. When present, this is the authoritative
  // current-label `indications_and_usage` text for the candidate's FDA
  // application. We use it as a semantic cross-check: if the label clearly
  // describes a different molecule or therapy area than the candidate
  // implies, that's a strong signal the deterministic resolver picked the
  // wrong application (the dominant #6 failure mode).
  const labelBlock =
    pipeline?.labelIndicationText && pipeline.labelIndicationText.trim()
      ? `Current FDA label "Indications and Usage" section for the candidate ` +
        `application (truncated if >${MAX_LABEL_CHARS} chars):\n` +
        `<<<LABEL\n${pipeline.labelIndicationText.slice(0, MAX_LABEL_CHARS)}\nLABEL>>>\n\n` +
        `Use this label text as the primary semantic check on the candidate.\n` +
        `- If the label clearly describes a DIFFERENT molecule or therapy area ` +
        `than the candidate's brand_name / generic_name imply, treat that as ` +
        `evidence the resolver matched the wrong application — set "agreement" ` +
        `to "correct" (with your earlier record) or "unknown" if you cannot ` +
        `produce a confident corrected record.\n` +
        `- If the label is consistent with the candidate, that strengthens ` +
        `the case for "confirm".\n` +
        `- Do not contradict the label text with claims about indications ` +
        `not visible in it.\n\n`
      : "";

  const schema =
    `Return JSON with this exact shape:\n` +
    `{\n` +
    `  "agreement": "confirm" | "correct" | "unknown",\n` +
    `  "status": "approved" | "discontinued" | "otc_monograph" | "not_found",\n` +
    `  "brand_name": string | null,           // original/innovator brand\n` +
    `  "generic_name": string | null,         // INN or generic name\n` +
    `  "application_number": string | null,   // e.g. "NDA021743" — include the prefix\n` +
    `  "application_type": "NDA" | "BLA" | "ANDA" | null,\n` +
    `  "approval_date": "YYYY-MM-DD" | null,  // ORIGINAL approval, not later supplements\n` +
    `  "sponsor": string | null,\n` +
    `  "confidence": "high" | "medium" | "low",\n` +
    `  "rationale": string                    // 1-2 sentences explaining the verdict\n` +
    `}\n\n` +
    `Rules:\n` +
    `- For internal/research codes (MK-3475, AZD9291) translate to INN first.\n` +
    `- Withdrawn/discontinued products are still "approved" or "discontinued".\n` +
    `- approval_date must be the FIRST FDA approval, even if decades old.\n` +
    `- If unsure of exact date or application number, set them to null and ` +
    `lower confidence — do not guess.`;

  return base + context + labelBlock + schema;
}

// JSON schema we ask Gemini to produce. Using response_schema constrains
// decoding so we don't have to defensively unwrap markdown fences.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    agreement: {
      type: "string",
      enum: ["confirm", "correct", "unknown"],
    },
    status: {
      type: "string",
      enum: ["approved", "discontinued", "otc_monograph", "not_found"],
    },
    brand_name: { type: "string", nullable: true },
    generic_name: { type: "string", nullable: true },
    application_number: { type: "string", nullable: true },
    application_type: {
      type: "string",
      enum: ["NDA", "BLA", "ANDA"],
      nullable: true,
    },
    approval_date: { type: "string", nullable: true },
    sponsor: { type: "string", nullable: true },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    rationale: { type: "string" },
  },
  required: ["agreement", "status", "confidence", "rationale"],
} as const;

// Token bucket per client IP. Lives in module scope so it survives within a
// single function instance; cold starts reset it. Good enough as a cost
// guard for a low-traffic research tool — for stronger guarantees we'd
// need an external store (Upstash, Netlify Blobs).
const RATE_LIMIT_CAPACITY = 30;
const RATE_LIMIT_REFILL_PER_SEC = 0.5;
interface Bucket {
  tokens: number;
  updatedAt: number;
}
const buckets = new Map<string, Bucket>();

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-nf-client-connection-ip") ?? "unknown";
}

function takeToken(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? {
    tokens: RATE_LIMIT_CAPACITY,
    updatedAt: now,
  };
  const elapsed = (now - b.updatedAt) / 1000;
  b.tokens = Math.min(
    RATE_LIMIT_CAPACITY,
    b.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC
  );
  b.updatedAt = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

interface VertexConfig {
  client: GoogleGenAI;
  projectId: string;
  region: string;
  model: string;
}

let cachedConfig: VertexConfig | null = null;
let cachedConfigError: string | null = null;

// Cache the SDK client across warm invocations — the Google auth flow
// also caches access tokens internally, so this avoids a fresh OAuth round
// trip per request.
function getVertexConfig(): VertexConfig | { error: string } {
  if (cachedConfig) return cachedConfig;
  if (cachedConfigError) return { error: cachedConfigError };

  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credsJson) {
    cachedConfigError = "missing GOOGLE_APPLICATION_CREDENTIALS_JSON";
    return { error: cachedConfigError };
  }
  let credentials: { project_id?: string; client_email?: string };
  try {
    credentials = JSON.parse(credsJson);
  } catch (e) {
    cachedConfigError = `invalid GOOGLE_APPLICATION_CREDENTIALS_JSON: ${
      e instanceof Error ? e.message : "unknown"
    }`;
    return { error: cachedConfigError };
  }
  const projectId =
    process.env.GCP_PROJECT_ID ?? credentials.project_id;
  if (!projectId) {
    cachedConfigError =
      "GCP_PROJECT_ID is unset and the service account JSON has no project_id";
    return { error: cachedConfigError };
  }

  const client = new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location: DEFAULT_REGION,
    googleAuthOptions: {
      credentials: credentials as Record<string, unknown>,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
  });
  cachedConfig = {
    client,
    projectId,
    region: DEFAULT_REGION,
    model: DEFAULT_MODEL,
  };
  return cachedConfig;
}

interface RequestBody {
  drugName?: string;
  // The client passes the deterministic pipeline's finding (if any) so the
  // model can verify-or-correct rather than reason blank-slate.
  pipelineFinding?: PipelineFinding;
  // model is accepted for forward compatibility but currently ignored — the
  // server-side env var is the source of truth.
  model?: string;
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const drugName = (body.drugName ?? "").trim();
  if (!drugName) {
    return json({ error: "drugName is required" }, 400);
  }
  if (drugName.length > MAX_DRUG_NAME_LEN) {
    return json({ error: "drugName too long" }, 400);
  }

  // Defensive: sanitize the label-text grounding field. Truncate to the
  // cap and drop it entirely if the type is wrong. Belt-and-suspenders for
  // a client that might serialize garbage.
  const pipelineFinding: PipelineFinding | undefined = body.pipelineFinding
    ? {
        ...body.pipelineFinding,
        labelIndicationText:
          typeof body.pipelineFinding.labelIndicationText === "string"
            ? body.pipelineFinding.labelIndicationText.slice(0, MAX_LABEL_CHARS)
            : undefined,
      }
    : undefined;

  const ip = clientIp(req);
  if (!takeToken(ip)) {
    return json(
      { error: "rate limit exceeded — try again in a few seconds" },
      429
    );
  }

  const cfg = getVertexConfig();
  if ("error" in cfg) {
    return json(
      { error: `LLM fallback not configured: ${cfg.error}` },
      503
    );
  }

  try {
    const contents: Content[] = [
      {
        role: "user",
        parts: [{ text: userPrompt(drugName, pipelineFinding) }],
      },
    ];
    const response = await cfg.client.models.generateContent({
      model: cfg.model,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: MAX_TOKENS,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    });
    // The client (`src/api/llm.ts`) expects an Anthropic-style message with
    // a `content: [{type:"text", text:...}]` shape. Mirror that so the
    // proxy/direct paths share parsing code on the client side.
    const text = response.text ?? "";
    return json({
      model: cfg.model,
      region: cfg.region,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: response.usageMetadata,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return json({ error: `vertex error: ${msg.slice(0, 400)}` }, 502);
  }
};

export const config = {
  path: "/api/llm-lookup",
};
