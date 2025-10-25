import type { Handler } from "@netlify/functions";
import fetch from "node-fetch";
import { openai } from "../../src/lib/openai.js";
import { mergeGroups, sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";

function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function isOriginAllowed(originHeader?: string): boolean {
  const allow = parseAllowedOrigins();
  if (!allow.length) return true;
  if (!originHeader) return false;
  try {
    const origin = new URL(originHeader).origin;
    return allow.includes(origin);
  } catch {
    return false;
  }
}

function corsHeaders(originHeader?: string) {
  const allow = parseAllowedOrigins();
  const allowedOrigin =
    originHeader && isOriginAllowed(originHeader) ? originHeader : allow[0] || "*";
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  } as Record<string, string>;
}

function jsonResponse(statusCode: number, body: unknown, originHeader?: string) {
  return {
    statusCode,
    headers: corsHeaders(originHeader),
    body: JSON.stringify(body),
  };
}

// Utility: split an array into evenly sized batches
function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// Verify if a URL is reachable with a quick HEAD request
async function verifyUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch (err) {
    console.warn(`HEAD failed for ${url}:`, (err as Error).message);
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RetryOpts = {
  maxRetries?: number;
  baseDelayMs?: number;
  factor?: number;
  jitterPct?: number;
};

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const factor = opts.factor ?? 2;
  const jitterPct = opts.jitterPct ?? 0.2;

  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      attempt++;

      const status = err?.status ?? err?.response?.status;
      const retryable =
        status === 429 ||
        (typeof status === "number" && status >= 500 && status < 600) ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "ECONNRESET" ||
        err?.name === "FetchError";

      if (!retryable || attempt > maxRetries) {
        break;
      }

      const delay = Math.round(baseDelayMs * Math.pow(factor, attempt - 1));
      const jitter = Math.round(delay * (Math.random() * 2 * jitterPct - jitterPct));
      const wait = Math.max(50, delay + jitter);
      console.warn(`🔁 Retry ${attempt}/${maxRetries} in ${wait}ms (status=${status ?? "n/a"})`);
      await sleep(wait);
    }
  }

  throw (lastErr as Error);
}

async function analyzeBatchWithOpenAI(batch: string[]) {
  const run = async () => {
    const content: any[] = [
      {
        type: "text",
        text: [
          "You are a product photo analyst.",
          "Group visually identical products together (front/back/side shots).",
          "Extract brand, product name, variant/flavor, size/servings, and category.",
          "Return STRICT JSON only: { groups: [{ groupId, brand, product, variant, size, category, claims, confidence, images }] }.",
          "If uncertain, group best-guess and lower confidence.",
        ].join("\n"),
      },
    ];

    for (const url of batch) {
      content.push({ type: "image_url", image_url: { url } });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a strict JSON-only product photo parser." },
        { role: "user", content },
      ],
    });

    const raw = response.choices[0]?.message?.content || "{}";
    return JSON.parse(raw);
  };

  try {
    return await withRetry(run, {
      maxRetries: 3,
      baseDelayMs: 300,
      factor: 2,
      jitterPct: 0.25,
    });
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    console.error("❌ OpenAI batch failed permanently:", status, err?.message || err);
    return {
      groups: [],
      _error: `OpenAI failed: status=${status ?? "n/a"} msg=${err?.message ?? "unknown"}`,
    };
  }
}

type AnalyzeRequest = {
  images?: string[];
  batchSize?: number;
};

export const handler: Handler = async (event) => {
  const originHdr = (event.headers["origin"] || event.headers["Origin"] ||
    event.headers["access-control-request-origin"]) as string | undefined;

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr);
  }

  const adminToken = process.env.ADMIN_API_TOKEN || "";
  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

  if (adminToken) {
    if (!token || token !== adminToken) {
      return jsonResponse(401, { error: "Unauthorized" }, originHdr);
    }
  }

  const ctype = event.headers["content-type"] || event.headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) {
    return jsonResponse(415, { error: "Use application/json" }, originHdr);
  }

  let payload: AnalyzeRequest = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return jsonResponse(400, { error: "Invalid JSON" }, originHdr);
  }

  let images = Array.isArray(payload.images) ? payload.images : [];
  images = sanitizeUrls(images).map(toDirectDropbox);

  if (images.length === 0) {
    return jsonResponse(400, { error: "No valid image URLs provided." }, originHdr);
  }

  const rawBatch = Number(payload.batchSize);
  const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 15) : 12;

  console.log("Cleaned images:", images);

  let verifiedImages: string[] = [];
  for (const url of images) {
    const okHead = await verifyUrl(url);
    if (okHead) {
      verifiedImages.push(url);
    } else {
      console.warn(`⚠️ Skipping unreachable image: ${url}`);
    }
  }

  const verifiedBatches = chunkArray(verifiedImages, batchSize);

  console.log("✅ Batches created:", verifiedBatches.length);
  console.log("✅ Images per batch:", verifiedBatches.map((b) => b.length));

  const analyzedResults: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];

  for (const [i, batch] of verifiedBatches.entries()) {
    console.log(`🧠 Analyzing batch ${i + 1}/${verifiedBatches.length} (${batch.length} images)`);
    const result = await analyzeBatchWithOpenAI(batch);
    if (result && typeof result === "object" && "_error" in result) {
      warnings.push(`Batch ${i + 1}: ${(result as { _error: string })._error}`);
    }
    analyzedResults.push(result);
  }

  console.log("🔍 Analysis complete. Total batches:", analyzedResults.length);

  const merged = mergeGroups(analyzedResults as Array<{ groups?: any[] }>);

  console.log("🧩 Merge complete. Groups:", merged.groups.length);
  console.log(
    JSON.stringify({
      evt: "analyze-images.done",
      batches: analyzedResults.length,
      groups: merged.groups.length,
      warningsCount: warnings.length,
    })
  );

  return jsonResponse(200, {
    status: "ok",
    info: "Multi-batch merge complete (with resilience).",
    summary: {
      batches: analyzedResults.length,
      totalGroups: merged.groups.length,
    },
    warnings,
    groups: merged.groups,
  }, originHdr);
};
