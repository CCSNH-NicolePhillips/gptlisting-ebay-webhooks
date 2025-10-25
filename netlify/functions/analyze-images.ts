import type { Handler } from "@netlify/functions";
import fetch from "node-fetch";
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

  const batches = chunkArray(images, batchSize);

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

  return ok({
    status: "ok",
    info: "Batch slicer + HEAD check complete.",
    received: {
      originalCount: images.length,
      verifiedCount: verifiedImages.length,
      batchSize,
      batches: verifiedBatches.length,
    },
  });
};
