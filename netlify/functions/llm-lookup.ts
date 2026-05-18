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
// the final answer is a tiny JSON object. 2048 is plenty for our schema.
const MAX_TOKENS = 2048;
const MAX_DRUG_NAME_LEN = 200;

const SYSTEM_PROMPT =
  "You are an FDA drug-approval lookup assistant for clinicians and " +
  "researchers. Given a drug name (brand, generic, or internal code), return " +
  "the *original* FDA approval record — the first time the active ingredient " +
  "was approved by FDA, not a later supplement, biosimilar, or generic ANDA. " +
  "If the drug is OTC under a monograph (e.g. acetaminophen/Tylenol), say so. " +
  "If you are not confident, say so via the confidence field — do NOT " +
  "fabricate application numbers or dates. Respond with ONLY a single JSON " +
  "object, no prose, no markdown fencing.";

function userPrompt(name: string): string {
  return (
    `Look up the original FDA approval for: ${JSON.stringify(name)}\n\n` +
    `Return JSON with this exact shape:\n` +
    `{\n` +
    `  "status": "approved" | "discontinued" | "otc_monograph" | "not_found",\n` +
    `  "brand_name": string | null,\n` +
    `  "generic_name": string | null,\n` +
    `  "application_number": string | null,\n` +
    `  "application_type": "NDA" | "BLA" | "ANDA" | null,\n` +
    `  "approval_date": "YYYY-MM-DD" | null,\n` +
    `  "sponsor": string | null,\n` +
    `  "confidence": "high" | "medium" | "low",\n` +
    `  "rationale": string\n` +
    `}\n\n` +
    `Rules:\n` +
    `- For internal/research codes (MK-3475, AZD9291) translate to INN first.\n` +
    `- Withdrawn or discontinued products are still "approved" or "discontinued".\n` +
    `- approval_date must be the FIRST FDA approval, even for older drugs.\n` +
    `- If unsure of exact date or application number, set those to null and ` +
    `lower confidence — do not guess.`
  );
}

// JSON schema we ask Gemini to produce. Using response_schema constrains
// decoding so we don't have to defensively unwrap markdown fences.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
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
  required: ["status", "confidence", "rationale"],
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
      { role: "user", parts: [{ text: userPrompt(drugName) }] },
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
