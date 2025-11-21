import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";
import { runSmartdraftsAnalysis } from "../../src/smartdrafts/analysisCore.js";

const METHODS = "POST, OPTIONS";
const MAX_IMAGES = Math.max(1, Math.min(100, Number(process.env.SMARTDRAFT_MAX_IMAGES || 100)));

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" }, originHdr, METHODS);
  }

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return jsonResponse(401, { ok: false, error: "Unauthorized" }, originHdr, METHODS);
  }

  const ctype = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
  if (!ctype.includes("application/json")) {
    return jsonResponse(415, { ok: false, error: "Use application/json" }, originHdr, METHODS);
  }

  let body: any = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON" }, originHdr, METHODS);
  }

  const folder = typeof body?.path === "string" ? body.path.trim() : "";
  const force = Boolean(body?.force);
  const limitRaw = Number(body?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_IMAGES) : MAX_IMAGES;
  const debugRaw = body?.debug;
  const debugEnabled = typeof debugRaw === "string"
    ? ["1", "true", "yes", "debug"].includes(debugRaw.toLowerCase())
    : Boolean(debugRaw);

  try {
    const analysis = await runSmartdraftsAnalysis(
      folder,
      { forceRescan: force },
      user.userId,
      undefined, // no stagedUrls
      false // skipQuota = false (enforce quota)
    );

    // Return same response format as before (for backward compatibility)
    return jsonResponse(200, {
      ok: true,
      cached: analysis.cached,
      folder: analysis.folder,
      signature: analysis.signature,
      count: analysis.groups.length,
      warnings: analysis.warnings || [],
      groups: analysis.groups,
      imageInsights: analysis.imageInsights || {},
    }, originHdr, METHODS);
  } catch (err: any) {
    return jsonResponse(500, { 
      ok: false, 
      error: err?.message || String(err) 
    }, originHdr, METHODS);
  }
};
