import fetch from "node-fetch";
import { openai } from "./openai.js";
import { mergeGroups, sanitizeUrls, toDirectDropbox } from "./merge.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  factor?: number;
  jitterPct?: number;
};

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const factor = opts.factor ?? 2;
  const jitterPct = opts.jitterPct ?? 0.25;

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
      await sleep(Math.max(50, delay + jitter));
    }
  }

  throw lastErr;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function verifyUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch (err) {
    console.warn(`HEAD failed for ${url}:`, (err as Error).message);
    return false;
  }
}

async function analyzeBatchWithOpenAI(batch: string[]) {
  const run = async () => {
    const content: any[] = [
      {
        type: "text",
        text: [
          "You are a product photo analyst.",
          "Group visually identical products (front/back/side).",
          "Extract: brand, product, variant/flavor, size/servings, category, short claims[].",
          "Return STRICT JSON: { groups: [{ groupId, brand, product, variant, size, category, claims, confidence, images[] }] }.",
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

    return JSON.parse(response.choices[0]?.message?.content || "{}");
  };

  try {
    return await withRetry(run);
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    console.error("❌ OpenAI batch failed permanently:", status, err?.message || err);
    return {
      groups: [],
      _error: `OpenAI failed: status=${status ?? "n/a"} msg=${err?.message ?? "unknown"}`,
    };
  }
}

export type AnalysisResult = {
  info: string;
  summary: {
    batches: number;
    totalGroups: number;
  };
  warnings: string[];
  groups: any[];
};

export async function runAnalysis(inputUrls: string[], rawBatchSize = 12): Promise<AnalysisResult> {
  let images = sanitizeUrls(inputUrls).map(toDirectDropbox);

  if (images.length === 0) {
    return {
      info: "No valid images",
      summary: { batches: 0, totalGroups: 0 },
      warnings: ["No valid image URLs"],
      groups: [],
    };
  }

  const batchSize = Math.min(Math.max(Number(rawBatchSize) || 12, 4), 20);

  const verified: string[] = [];
  for (const url of images) {
    const reachable = await verifyUrl(url);
    if (reachable) {
      verified.push(url);
    } else {
      console.warn(`⚠️ Skipping unreachable image: ${url}`);
    }
  }

  const verifiedBatches = chunkArray(verified, batchSize);

  const analyzedResults: any[] = [];
  const warnings: string[] = [];

  for (const [idx, batch] of verifiedBatches.entries()) {
    console.log(`🧠 Analyzing batch ${idx + 1}/${verifiedBatches.length} (${batch.length} images)`);
    const result = await analyzeBatchWithOpenAI(batch);
    if (result?._error) {
      warnings.push(`Batch ${idx + 1}: ${result._error}`);
    }
    analyzedResults.push(result);
  }

  const merged = mergeGroups(analyzedResults);
  console.log("🧩 Merge complete. Groups:", merged.groups.length);
  console.log(
    JSON.stringify({
      evt: "analyze-images.done",
      batches: verifiedBatches.length,
      groups: merged.groups.length,
      warningsCount: warnings.length,
    })
  );

  return {
    info: "Multi-batch merge complete (with resilience).",
    summary: {
      batches: verifiedBatches.length,
      totalGroups: merged.groups.length,
    },
    warnings,
    groups: merged.groups,
  };
}
