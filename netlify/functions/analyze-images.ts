import type { Handler } from "@netlify/functions";
import fetch from "node-fetch";
import { openai } from "../../src/lib/openai.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";

function ok(body: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
    body: JSON.stringify(body),
  };
}

function bad(status: number, message: string) {
  return ok({ error: message }, status);
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

async function analyzeBatchWithOpenAI(batch: string[]) {
  try {
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
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.error("❌ OpenAI Vision batch failed:", err);
    return { groups: [], error: (err as Error).message };
  }
}

type AnalyzeRequest = {
  images?: string[];
  batchSize?: number;
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return ok({});
  }

  if (event.httpMethod !== "POST") {
    return bad(405, "Method not allowed. Use POST.");
  }

  const ctype = event.headers["content-type"] || event.headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) {
    return bad(415, "Unsupported content-type. Use application/json.");
  }

  let payload: AnalyzeRequest = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return bad(400, "Invalid JSON.");
  }

  let images = Array.isArray(payload.images) ? payload.images : [];
  images = sanitizeUrls(images).map(toDirectDropbox);

  if (images.length === 0) {
    return bad(400, "No valid image URLs provided.");
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

  for (const [i, batch] of verifiedBatches.entries()) {
    console.log(`🧠 Analyzing batch ${i + 1}/${verifiedBatches.length} (${batch.length} images)`);
    const result = await analyzeBatchWithOpenAI(batch);
    analyzedResults.push(result);
  }

  console.log("🔍 Analysis complete. Total batches:", analyzedResults.length);

  const totalGroups = analyzedResults.reduce((acc, item) => {
    const groups = Array.isArray((item as any).groups) ? (item as any).groups.length : 0;
    return acc + groups;
  }, 0);

  return ok({
    status: "ok",
    info: "Vision batch analysis complete.",
    summary: {
      batches: analyzedResults.length,
      totalGroups,
    },
    results: analyzedResults,
  });
};
