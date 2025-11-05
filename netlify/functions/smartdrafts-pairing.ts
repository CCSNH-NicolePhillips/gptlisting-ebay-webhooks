import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { runPairing } from "../../src/pairing/runPairing.js";
import OpenAI from "openai";

/**
 * Utility: Extract canonical key from URL (strips prefixes like EBAY_, ebay/, etc.)
 */
function urlKey(u: string): string {
  const t = (u || '').trim().toLowerCase().replace(/\s*\|\s*/g, '/');
  const noQuery = t.split('?')[0];
  const base = noQuery.split('/').pop() || noQuery;
  return base.replace(/^(ebay[_-])/i, '');   // strip uploader prefix
}

/**
 * Utility: Check if URL is https
 */
const isHttps = (u?: string) => /^https?:\/\//i.test(String(u || ''));

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

    // CHUNK C.1: Canonicalize keys and hydrate display URLs
    const analysis = payload.analysis;
    
    // Normalize imageInsights to array
    const insights: any[] = Array.isArray(analysis.imageInsights)
      ? analysis.imageInsights
      : Object.values(analysis.imageInsights || {});

    // Build lookup maps
    const displayByKey = new Map<string, string>();
    const roleByKey = new Map<string, string>();

    for (const ins of insights) {
      const k = ins.key || urlKey(ins.url);
      if (!k) continue;
      roleByKey.set(k, (ins.role || '').toLowerCase());
      if (isHttps(ins.displayUrl)) displayByKey.set(k, ins.displayUrl);
    }

    // Brand/product by key (from analysis.groups)
    const brandByKey = new Map<string, string>();
    const productByKey = new Map<string, string>();

    for (const g of analysis.groups || []) {
      const brand = String(g.brand || '').trim();
      const prod = String(g.product || '').trim();
      for (const img of (g.images || [])) {
        const k = urlKey(img);
        if (brand) brandByKey.set(k, brand);
        if (prod) productByKey.set(k, prod);
      }
    }

    // Canonicalize pairs to keys and hydrate metadata
    for (const p of result.pairs || []) {
      const fk = urlKey(p.frontUrl);
      const bk = urlKey(p.backUrl);
      p.frontUrl = fk;
      p.backUrl = bk;
      
      // Carry brand/product from the front key if available
      if (!p.brand || p.brand === 'unknown') p.brand = brandByKey.get(fk) || p.brand || '';
      if (!p.product || !p.product.length) p.product = productByKey.get(fk) || p.product || '';
    }

    // Canonicalize products to keys and add display URLs
    for (const pr of result.products || []) {
      const fk = urlKey(pr.frontUrl);
      const bk = urlKey(pr.backUrl);
      pr.frontUrl = fk;
      pr.backUrl = bk;

      // Hydrate https display URLs for UI cards
      pr.heroDisplayUrl = displayByKey.get(fk) || pr.heroDisplayUrl || pr.frontUrl;
      pr.backDisplayUrl = displayByKey.get(bk) || pr.backDisplayUrl || pr.backUrl;

      // Carry metadata if missing
      if (!pr.evidence?.brand || pr.evidence.brand === 'unknown') {
        if (!pr.evidence) pr.evidence = {} as any;
        (pr.evidence as any).brand = brandByKey.get(fk) || (pr.evidence as any).brand || '';
      }
      if (!pr.evidence?.product || !(pr.evidence as any).product.length) {
        if (!pr.evidence) pr.evidence = {} as any;
        (pr.evidence as any).product = productByKey.get(fk) || (pr.evidence as any).product || '';
      }
    }

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
