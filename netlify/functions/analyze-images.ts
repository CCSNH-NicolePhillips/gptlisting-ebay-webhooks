import type { Handler } from "@netlify/functions";
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
  const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 20) : 12;

  console.log("Cleaned images:", images);

  return ok({
    status: "ok",
    info: "Analyze endpoint scaffolded. Vision not enabled yet.",
    received: {
      imagesCount: images.length,
      batchSize,
    },
  });
};
