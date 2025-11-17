import type { Handler } from "@netlify/functions";
import fetch from "node-fetch";
import { createHash } from "node:crypto";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { getCachedSmartDraftGroups } from "../../src/lib/smartdrafts-store.js";
import OpenAI from "openai";
import { runPairing } from "../../src/pairing/runPairing.js";

/**
 * POST /.netlify/functions/smartdrafts-pairing
 * Body: { analysis?: VisionOutput, folder?: string, overrides?: Record<string, any> }
 *
 * NEW: Can now accept EITHER:
 *   - analysis object (old way, prone to data loss through UI)
 *   - folder URL (new way, fetches fresh scan data from cache)
 *
 * CHUNK Z2: Bullet-proof pairing with 4 products (supplements + hair), ignoring dummy
 */

// Helper: Direct Redis GET for arbitrary keys
async function redisGet(key: string): Promise<any | null> {
  const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
  const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!BASE || !TOKEN) return null;

  try {
    const url = `${BASE}/GET/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    if (!res.ok) return null;

    const json = await res.json() as { result: unknown };
    const val = json.result;
    if (typeof val !== "string" || !val) return null;

    return JSON.parse(val);
  } catch {
    return null;
  }
}

// 0) Utilities
const HTTPS = /^https?:\/\//i;
const isHttps = (u?: string) => HTTPS.test(String(u || ''));

function urlKey(u: string) {
  const t = (u || '').trim().toLowerCase().replace(/\s*\|\s*/g, '/');
  const noQ = t.split('?')[0];
  const base = noQ.split('/').pop() || noQ;
  return base.replace(/^(ebay[_-])/i, '');
}

function tok(s?: string | null): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function jac(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

function bucket(path?: string | null): string {
  const s = (path || '').toLowerCase();
  if (/supplement|vitamin|nutrition/.test(s)) return 'supp';
  if (/food|beverage|grocery/.test(s)) return 'food';
  if (/hair/.test(s)) return 'hair';
  if (/cosm|skin|spf|make ?up/.test(s)) return 'cosm';
  return 'other';
}

function catCompat(a?: string | null, b?: string | null): number {
  const A = bucket(a), B = bucket(b);
  if (A === B && A !== 'other') return 1.0;
  if ((A === 'hair' && (B === 'supp' || B === 'food')) || (B === 'hair' && (A === 'supp' || A === 'food'))) return -1.0;
  if ((A === 'supp' && B === 'food') || (A === 'food' && B === 'supp')) return 0.4;
  return 0.2;
}

type Pair = {
  frontUrl: string;
  backUrl: string;
  matchScore: number;
  brand: string;
  product: string;
  evidence: string[];
  confidence: number;
};

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

  let payload: { analysis?: any; folder?: string; overrides?: Record<string, any> } = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return jsonResponse(400, { error: "Invalid JSON" }, originHdr, methods);
  }

  console.log('[PAIR] Received payload keys:', Object.keys(payload));
  console.log('[PAIR] payload.folder:', payload.folder);
  console.log('[PAIR] payload.analysis exists?', !!payload.analysis);
  if (payload.analysis) {
    console.log('[PAIR] payload.analysis.jobId:', (payload.analysis as any)?.jobId);
  }

  // ZF-2: Zero-frontend fix - fetch analysis from Redis without relying on UI
  let analysis: any = payload.analysis || null;
  const jobId = (payload as any)?.jobId || (analysis as any)?.jobId || null;
  const folder = payload.folder || (analysis as any)?.folder || '';

  // Helper function to check if analysis has valid visualDescription fields
  function hasVD(a: any): boolean {
    if (!a?.imageInsights) return false;
    const arr = Array.isArray(a.imageInsights) ? a.imageInsights : Object.values(a.imageInsights);
    if (!arr.length) return false;
    const first = arr[0] as any;
    return !!first?.visualDescription && (first.visualDescription.length > 20);
  }

  // ZF-2.1: Try by jobId first (if present in request)
  if (!hasVD(analysis) && jobId) {
    console.log(`[PAIR] Attempting Redis fetch for jobId=${jobId}`);
    try {
      const raw = await redisGet(`analysis:${jobId}`);
      if (raw) {
        analysis = raw;
        const arr = Array.isArray(analysis.imageInsights)
          ? analysis.imageInsights
          : Object.values(analysis.imageInsights || {});
        console.log(`[PAIR] loaded analysis by jobId: ${jobId}, insights=${arr.length}`);
      }
    } catch (err) {
      console.error(`[PAIR] Redis fetch failed for jobId=${jobId}:`, err);
    }
  }

  // ZF-2.2: If still no VD and we have a folder, try by folder signature
  if (!hasVD(analysis) && folder) {
    const folderSig = createHash('sha1').update(folder).digest('hex');
    console.log(`[PAIR] No VD yet, trying by folderSig: ${folderSig}`);

    try {
      // Try direct folder lookup
      const rawByFolder = await redisGet(`analysis:byFolder:${folderSig}`);
      if (rawByFolder) {
        analysis = rawByFolder;
        console.log(`[PAIR] loaded analysis by folderSig: ${folderSig}`);
      } else {
        // Last resort: use lastJobId pointer
        const lastIdRaw = await redisGet(`analysis:lastJobId:${folderSig}`);
        if (lastIdRaw && typeof lastIdRaw === 'string') {
          console.log(`[PAIR] Found lastJobId pointer: ${lastIdRaw}`);
          const rawByLast = await redisGet(`analysis:${lastIdRaw}`);
          if (rawByLast) {
            analysis = rawByLast;
            console.log(`[PAIR] loaded analysis by lastJobId: ${lastIdRaw}`);
          }
        }
      }
    } catch (err) {
      console.error(`[PAIR] Redis folder-based fetch failed:`, err);
    }
  }

  // ZF-2.3: Final fallback to old folder cache (for backward compatibility)
  if (!analysis && folder) {
    console.log(`[pairing] Fallback to old folder cache for: ${folder}`);
    const normalizeFolderKey = (value: string): string => {
      return value.replace(/^[\\/]+/, "").trim();
    };
    const cacheKey = normalizeFolderKey(folder);
    const cached = await getCachedSmartDraftGroups(cacheKey);

    if (!cached) {
      return jsonResponse(404, {
        error: "No cached scan found for this folder",
        hint: "Run Analyze first, then Run Pairing"
      }, originHdr, methods);
    }

    console.log(`[pairing] Found cached scan with ${Object.keys(cached.imageInsights || {}).length} imageInsights`);

    // Log sample to verify visualDescription is present
    const sampleKey = Object.keys(cached.imageInsights || {})[0];
    if (sampleKey) {
      const sample = (cached.imageInsights || {})[sampleKey] as any;
      console.log(`[pairing] Sample insight ${sampleKey}:`);
      console.log(`  - has visualDescription: ${!!sample.visualDescription}`);
      console.log(`  - visualDescription length: ${(sample.visualDescription || '').length}`);
    }

    analysis = {
      groups: cached.groups,
      orphans: cached.orphans,
      imageInsights: cached.imageInsights
    };
  }

  // ZF-2.4: Check if we have visualDescription after all fallbacks
  if (!hasVD(analysis)) {
    console.warn('[PAIR] no visualDescription available after redis fallbacks');
    // Continue with degraded pairing (visual similarity will be 0)
  } else {
    const arr = Array.isArray(analysis.imageInsights)
      ? analysis.imageInsights
      : Object.values(analysis.imageInsights || {});
    const first = arr[0] as any;
    console.log(`[PAIR] ✓ visualDescription available (first insight len=${first?.visualDescription?.length || 0})`);
  }

  // Final check: do we have analysis?
  if (!analysis) {
    return jsonResponse(400, {
      error: "Could not load analysis",
      hint: "Provide jobId, folder, or analysis in request body"
    }, originHdr, methods);
  }

  // Log final state
  if (hasVD(analysis)) {
    const arr = Array.isArray(analysis.imageInsights)
      ? analysis.imageInsights
      : Object.values(analysis.imageInsights || {});
    const first = arr[0] as any;
    console.log(`[PAIR] Final analysis has visualDescription ✓ (first insight len=${first?.visualDescription?.length || 0})`);
  } else {
    console.warn(`[PAIR] Final analysis MISSING visualDescription - visual similarity will be 0`);
  }

  if (!analysis || !analysis.imageInsights) {
    return jsonResponse(400, {
      error: "analysis.imageInsights required",
      hint: "Run Analyze first to generate image insights"
    }, originHdr, methods);
  }

  // Convert imageInsights from object to array if needed (runPairing expects array)
  const normalizedAnalysis = {
    groups: analysis.groups,
    imageInsights: Array.isArray(analysis.imageInsights)
      ? analysis.imageInsights
      : Object.values(analysis.imageInsights || {})
  };

  try {
    // USE NEW PAIRING SYSTEM with color matching, distributor rescue, and role override
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
    
    console.log('[PAIR] Using NEW pairing system (runPairing) with visual similarity');
    const { result, metrics } = await runPairing({
      client,
      analysis: normalizedAnalysis,
      log: console.log
    });
    
    console.log('[PAIR] Pairing complete:', {
      pairs: result.pairs.length,
      singletons: result.singletons.length,
      autoPairs: metrics.totals.autoPairs,
      modelPairs: metrics.totals.modelPairs
    });

    // Convert to expected format for UI
    const pairs = result.pairs.map(p => ({
      frontUrl: p.frontUrl,
      backUrl: p.backUrl,
      matchScore: p.matchScore,
      confidence: p.confidence,
      brand: p.brand,
      product: p.product,
      evidence: p.evidence || []
    }));

    const singletons = result.singletons.map(s => ({
      url: s.url,
      reason: s.reason
    }));

    // Build debug summary
    const debugSummary: string[] = [];
    
    // Add role information (use normalizedAnalysis which has array)
    const insights = normalizedAnalysis.imageInsights;
    const roleMap: [string, string][] = [];
    for (const ins of insights) {
      const k = ins.key || urlKey(ins.url);
      roleMap.push([k, String(ins.role || 'unknown')]);
    }
    debugSummary.push(`All roles: ${JSON.stringify(roleMap)}`);

    // Add brand information
    const brandMap: [string, string][] = [];
    for (const g of (normalizedAnalysis.groups || [])) {
      const b = String(g.brand || '').trim();
      for (const u of (g.images || [])) {
        const k = urlKey(u);
        if (b) brandMap.push([k, b]);
      }
    }
    debugSummary.push(`All brands: ${JSON.stringify(brandMap)}`);

    // Add category information
    const catMap: [string, string][] = [];
    for (const g of (normalizedAnalysis.groups || [])) {
      const c = String(g.categoryPath || g.category || '').trim();
      for (const u of (g.images || [])) {
        const k = urlKey(u);
        if (c) catMap.push([k, c]);
      }
    }
    debugSummary.push(`All categories: ${JSON.stringify(catMap)}`);

    return jsonResponse(200, {
      pairs,
      singletons,
      debugSummary,
      metrics: {
        totalImages: metrics.totals.images,
        totalPairs: metrics.totals.autoPairs + metrics.totals.modelPairs,
        autoPairs: metrics.totals.autoPairs,
        modelPairs: metrics.totals.modelPairs,
        singletons: metrics.totals.singletons
      }
    }, originHdr, methods);

  } catch (err) {
    console.error("[smartdrafts-pairing] error:", err);
    return jsonResponse(500, {
      error: "Pairing failed",
      message: (err as any)?.message || String(err)
    }, originHdr, methods);
  }
};
