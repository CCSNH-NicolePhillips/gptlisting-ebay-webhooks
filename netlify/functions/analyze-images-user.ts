import type { Handler } from '../../src/types/api-handler.js';
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { runAnalysis } from "../../src/lib/analyze-core.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";
import { canConsumeImages, consumeImages } from "../../src/lib/quota.js";

type HeadersMap = Record<string, string | undefined>;

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);
  const methods = "POST, OPTIONS";

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" }, originHdr, methods);
  }

  if (!isOriginAllowed(originHdr)) {
    return json(403, { error: "Forbidden" }, originHdr, methods);
  }

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    const mode = (process.env.AUTH_MODE || "admin").toLowerCase();
    return json(
      401,
      { error: "Unauthorized", detail: `User endpoints require AUTH_MODE=user|mixed (current: ${mode}) or a valid user token.` },
      originHdr,
      methods
    );
  }

  const ctype = headers["content-type"] || headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) {
    return json(415, { error: "Use application/json" }, originHdr, methods);
  }

  let body: any = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON" }, originHdr, methods);
  }

  const images = sanitizeUrls(Array.isArray(body.images) ? body.images : []).map(toDirectDropbox);
  if (images.length === 0) {
    return json(400, { error: "No valid image URLs provided." }, originHdr, methods);
  }

  if (images.length > 3) {
    return json(202, { status: "redirect", endpoint: "/.netlify/functions/analyze-images-bg-user" }, originHdr, methods);
  }

  try {
    const allowed = await canConsumeImages(user.userId, images.length);
    if (!allowed) {
      return json(429, { error: "Daily image quota exceeded" }, originHdr, methods);
    }
    await consumeImages(user.userId, images.length);
  } catch (err) {
    console.error("[analyze-images-user] quota failure", err);
    return json(500, { error: "Failed to apply quota" }, originHdr, methods);
  }

  const rawBatch = Number(body.batchSize);
  const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;

  const result = await runAnalysis(images, batchSize);
  console.log(
    JSON.stringify({ evt: "analyze-images-user.done", ok: true, userId: user.userId, count: images.length })
  );
  return json(200, { ...result, user: true }, originHdr, methods);
};
