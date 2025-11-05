import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { runPairing } from "../../src/pairing/runPairing.js";
import OpenAI from "openai";

/**
 * POST /.netlify/functions/smartdrafts-pairing
 * Body: { analysis?: VisionOutput, overrides?: Record<string, any> }
 * 
 * Runs the pairing algorithm from src/pairing/ on analysis results
 * Returns { pairing: PairingResult, metrics?: Metrics }
 */

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);
  const methods = "POST, OPTIONS";

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, methods);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, methods);
  }

  const ctype = headers["content-type"] || headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) {
    return jsonResponse(415, { error: "Use application/json" }, originHdr, methods);
  }

  let payload: { analysis?: any; overrides?: Record<string, any> } = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return jsonResponse(400, { error: "Invalid JSON" }, originHdr, methods);
  }

  // Need analysis data to run pairing
  if (!payload.analysis || !payload.analysis.imageInsights) {
    return jsonResponse(400, { 
      error: "analysis required in body",
      hint: "POST { analysis: { groups, imageInsights }, overrides?: {} }"
    }, originHdr, methods);
  }

  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    const client = new OpenAI({ apiKey: openaiKey });
    const { result, metrics } = await runPairing({
      client,
      analysis: payload.analysis,
      model: "gpt-4o-mini"
    });

    return jsonResponse(200, { 
      ok: true,
      pairing: result, 
      metrics 
    }, originHdr, methods);
  } catch (error: any) {
    console.error("[smartdrafts-pairing] error:", error);
    return jsonResponse(500, {
      error: "Pairing failed",
      message: error?.message || String(error)
    }, originHdr, methods);
  }
};
