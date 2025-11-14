import type { Handler } from "@netlify/functions";
import { createHash } from "crypto";
import fetch from "node-fetch";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { getCachedSmartDraftGroups } from "../../src/lib/smartdrafts-store.js";
import { getJob } from "../../src/lib/job-store.js";

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

  try {

    // 1) Build maps from analysis
    const insights = Array.isArray(analysis.imageInsights)
      ? analysis.imageInsights
      : Object.values(analysis.imageInsights || {});

    const role = new Map<string, string>();
    const disp = new Map<string, string>();
    for (const ins of insights) {
      const k = ins.key || urlKey(ins.url);
      if (!k) continue;
      role.set(k, String(ins.role || 'unknown').toLowerCase());
      if (isHttps(ins.displayUrl)) disp.set(k, ins.displayUrl);
    }

    const brand = new Map<string, string>();
    const prod = new Map<string, string>();
    const cat = new Map<string, string>();
    const gOfKey = new Map<string, string>();
    for (const g of (analysis.groups || [])) {
      const b = String(g.brand || '').trim();
      const p = String(g.product || '').trim();
      const c = String(g.categoryPath || g.category || '').trim();
      for (const u of (g.images || [])) {
        const k = urlKey(u);
        gOfKey.set(k, g.groupId || g.name || '');
        if (b) brand.set(k, b);
        if (p) prod.set(k, p);
        if (c) cat.set(k, c);
      }
    }

    // 2) Cues: supplement facts and hair-back INCI
    const facts = new Set<string>();
    const hairB = new Set<string>();
    const visual = new Map<string, string>(); // Store visualDescription for each image
    
    for (const ins of insights) {
      const k = ins.key || urlKey(ins.url);
      const ev = (ins.evidenceTriggers || []).join(' ').toLowerCase();
      const tx = (ins.textExtracted || '').toLowerCase();
      const vd = String((ins as any).visualDescription || '').toLowerCase();
      
      console.log(`[Z2-DEBUG] Image ${k}:`);
      console.log(`  - visualDescription present: ${!!(ins as any).visualDescription}`);
      console.log(`  - visualDescription length: ${vd.length}`);
      console.log(`  - visualDescription value: "${vd}"`);
      visual.set(k, vd);
      
      if (/(supplement facts|nutrition facts|drug facts|serving size|other ingredients)/.test(ev) ||
          /(supplement facts|nutrition facts|drug facts|serving size|other ingredients)/.test(tx)) {
        facts.add(k);
      }
      if (/ingredients:|avoid contact with eyes|apply to (damp|dry) hair|12m|24m/.test(ev + tx)) {
        hairB.add(k);
      }
    }

    // Helper: Extract visual features from description
    function extractVisualFeatures(desc: string): Set<string> {
      const features = new Set<string>();
      const words = desc.toLowerCase().split(/[\s,\-/]+/);
      
      // Packaging types
      const packaging = ['bottle', 'jar', 'pouch', 'tube', 'canister', 'dropper', 'pump', 'spray', 'tin', 'box'];
      // Shapes
      const shapes = ['cylindrical', 'rectangular', 'oval', 'square', 'flat', 'stand-up'];
      // Materials
      const materials = ['plastic', 'glass', 'metallic', 'foil', 'paper', 'cardboard', 'glossy', 'matte', 'clear', 'frosted'];
      // Colors
      const colors = ['white', 'black', 'blue', 'green', 'red', 'yellow', 'purple', 'orange', 'brown', 'pink', 'amber', 'transparent', 'silver', 'gold'];
      // Closures
      const closures = ['screw', 'flip', 'pump', 'dropper', 'spray', 'twist', 'zip', 'resealable'];
      // Special features
      const special = ['window', 'embossed', 'holographic', 'tear', 'tamper', 'band'];
      
      const allKeywords = [...packaging, ...shapes, ...materials, ...colors, ...closures, ...special];
      
      for (const word of words) {
        if (allKeywords.includes(word)) {
          features.add(word);
        }
      }
      
      return features;
    }

    // Helper: Calculate visual similarity between two images
    function visualSimilarity(key1: string, key2: string): number {
      const desc1 = visual.get(key1) || '';
      const desc2 = visual.get(key2) || '';
      
      if (!desc1 || !desc2) return 0;
      
      const features1 = extractVisualFeatures(desc1);
      const features2 = extractVisualFeatures(desc2);
      
      if (features1.size === 0 || features2.size === 0) return 0;
      
      // Jaccard similarity
      const intersection = new Set([...features1].filter(x => features2.has(x)));
      const union = new Set([...features1, ...features2]);
      
      return intersection.size / union.size;
    }

    // 3) Intra-group pairs first (myBrainCo & Frog Fuel)
    const pairs: Pair[] = [];
    const pairedF = new Set<string>(), pairedB = new Set<string>();

    // DEBUG: Log all detected roles/brands/categories
    console.log('[Z2-DEBUG] All image roles:', Array.from(role.entries()));
    console.log('[Z2-DEBUG] All brands:', Array.from(brand.entries()));
    console.log('[Z2-DEBUG] All categories:', Array.from(cat.entries()));
    console.log('[Z2-DEBUG] Supplement facts detected:', Array.from(facts));
    console.log('[Z2-DEBUG] INCI (hair) detected:', Array.from(hairB));

    for (const g of (analysis.groups || [])) {
      const keys = (g.images || []).map((u: any) => urlKey(u));
      const fronts = keys.filter((k: string) => role.get(k) === 'front');
      const backs = keys.filter((k: string) => role.get(k) === 'back');
      if (!fronts.length || !backs.length) continue;

      const f = fronts[0], b = backs[0];
      pairs.push({
        frontUrl: f, backUrl: b, matchScore: 6.5, confidence: .95,
        brand: g.brand || brand.get(f) || '', product: g.product || prod.get(f) || '',
        evidence: ['INTRA-GROUP: front/back in same group']
      });
      pairedF.add(f); pairedB.add(b);
    }

    // 4) Cross-group scoring (for Nusava and R+Co)
    function preScore(fk: string, bk: string): number {
      const fBrand = (brand.get(fk) || '').toLowerCase();
      const bBrand = (brand.get(bk) || '').toLowerCase();
      const brandEq = !!fBrand && !!bBrand && fBrand === bBrand;

      let s = 0;
      if (brandEq) s += 2.0;
      const pSim = jac(tok(prod.get(fk)), tok(prod.get(bk)));
      s += pSim >= .6 ? 1.5 : pSim >= .4 ? 1.0 : 0;
      const cc = catCompat(cat.get(fk), cat.get(bk));
      s += cc >= .6 ? 1.0 : cc >= .2 ? 0.2 : cc <= -0.5 ? -2.0 : 0;

      if (role.get(fk) === 'front' && role.get(bk) === 'back') s += 1.0;

      // Visual similarity bonus (NEW! - Exponential scaling to break ties)
      const vSim = visualSimilarity(fk, bk);
      console.log(`[Z2-VISUAL] ${fk} ↔ ${bk}: vSim=${vSim.toFixed(3)}`);
      if (vSim >= 0.8) {
        s += 3.0; // Very strong visual match (near-perfect)
      } else if (vSim >= 0.5) {
        s += 2.0; // Strong visual match
      } else if (vSim >= 0.3) {
        s += 1.0; // Moderate visual match
      } else if (vSim >= 0.15) {
        s += 0.5; // Weak visual match
      }

      // Supplement-back rescue (only with facts cue)
      if (bucket(cat.get(fk)) === 'supp' && role.get(bk) === 'back' && facts.has(bk)) s += 1.5;

      // Hair/cosmetics rescue (only with INCI cue)
      if (bucket(cat.get(fk)) === 'hair' && role.get(bk) === 'back' && hairB.has(bk)) s += 1.4;

      return s;
    }

    // 5) Cross-group pairing with gap rule
    const allKeys: string[] = Array.from(new Set((analysis.groups || []).flatMap((g: any) => (g.images || []).map(urlKey))));
    const fr = allKeys.filter(k => role.get(k) === 'front' && !pairedF.has(k));
    const bk = allKeys.filter(k => role.get(k) === 'back' && !pairedB.has(k));

    console.log('[Z2-DEBUG] Unpaired fronts:', fr);
    console.log('[Z2-DEBUG] Unpaired backs:', bk);

    const crossGroupDebug: string[] = [];

    for (const f of fr) {
      const scored = bk
        .filter(b => !pairedB.has(b)) // Skip already-paired backs
        .filter(b => gOfKey.get(b) !== gOfKey.get(f))
        .map(b => ({ b, s: preScore(f, b) }))
        .sort((a, b) => b.s - a.s);
      
      console.log(`[Z2-DEBUG] Front ${f} scores:`, scored);
      
      if (!scored.length) continue;

      const best = scored[0], runner = scored[1];
      const gap = best.s - (runner?.s ?? -Infinity);
      const fBuck = bucket(cat.get(f));

      const scoreDetail = `Front ${f}: best=${best.s.toFixed(2)} (to ${best.b}), gap=${gap.toFixed(2)}, bucket=${fBuck}, cat=${cat.get(f)}`;
      console.log(`[Z2-DEBUG] ${scoreDetail}`);
      crossGroupDebug.push(scoreDetail);

      // strict accept
      if (best.s >= 3.0 && gap >= 1.0) {
        const msg = `✓ STRICT ACCEPT: ${f} ↔ ${best.b}`;
        console.log(`[Z2-DEBUG] ${msg}`);
        crossGroupDebug.push(msg);
        pairs.push({
          frontUrl: f, backUrl: best.b as string, matchScore: +best.s.toFixed(2), confidence: .95,
          brand: brand.get(f) || '', product: prod.get(f) || '',
          evidence: [`AUTO (cross) preScore=${best.s.toFixed(2)} gap=${gap === Infinity ? 'Inf' : gap.toFixed(2)}`]
        });
        pairedF.add(f); pairedB.add(best.b as string);
        continue;
      }
      
      // soft accept only with cue & higher score (Step 2A)
      const hasCue = (fBuck === 'supp' && facts.has(best.b as string)) 
                  || (fBuck === 'hair' && hairB.has(best.b as string));
      if (hasCue && best.s >= 2.6 && gap >= 0.8) {
        const msg = `✓ SOFT ACCEPT (${fBuck}, with cue): ${f} ↔ ${best.b}`;
        console.log(`[Z2-DEBUG] ${msg}`);
        crossGroupDebug.push(msg);
        pairs.push({
          frontUrl: f, backUrl: best.b as string, matchScore: +best.s.toFixed(2), confidence: .95,
          brand: brand.get(f) || '', product: prod.get(f) || '',
          evidence: [`SOFT ACCEPT preScore=${best.s.toFixed(2)} gap=${gap === Infinity ? 'Inf' : gap.toFixed(2)}`]
        });
        pairedF.add(f); pairedB.add(best.b as string);
        continue;
      }
      
      // Reject if no rule matched
      const msg = `✗ REJECT: ${f} (score=${best.s.toFixed(2)}, gap=${gap.toFixed(2)}, bucket=${fBuck}, needs cue+score>=2.6+gap>=0.8)`;
      console.log(`[Z2-DEBUG] ${msg}`);
      crossGroupDebug.push(msg);
    }

    // 6) Build products[] with https thumbs (ignore dummy "handbag" role items)
    const handbagKeys = allKeys.filter(k => role.get(k) === 'other');
    const dummy = new Set(handbagKeys);

    // Note: Let pairing decide what's valid - don't pre-filter by category
    // Users might sell books, accessories, etc. as legitimate products
    const products = pairs
      .filter(p => !dummy.has(p.frontUrl) && !dummy.has(p.backUrl))
      .map(p => ({
        productId: `${(brand.get(p.frontUrl) || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${tok(prod.get(p.frontUrl)).join('_')}`.replace(/^_+|_+$/g, '') || `${p.frontUrl}_${p.backUrl}`,
        brand: brand.get(p.frontUrl) || '',
        product: prod.get(p.frontUrl) || '',
        variant: null,
        size: null,
        categoryPath: cat.get(p.frontUrl) || '',
        frontUrl: p.frontUrl,
        backUrl: p.backUrl,
        heroDisplayUrl: disp.get(p.frontUrl) || p.frontUrl,
        backDisplayUrl: disp.get(p.backUrl) || p.backUrl,
        extras: [],
        evidence: p.evidence
      }));

    // 7) Debug summary
    console.log('[pairs]', pairs.map(p => `${p.frontUrl}↔${p.backUrl}:${p.matchScore}`));

    const debugSummary = [
      `All roles: ${JSON.stringify(Array.from(role.entries()))}`,
      `All brands: ${JSON.stringify(Array.from(brand.entries()))}`,
      `All categories: ${JSON.stringify(Array.from(cat.entries()))}`,
      `Supplement facts: ${JSON.stringify(Array.from(facts))}`,
      `INCI (hair): ${JSON.stringify(Array.from(hairB))}`,
      `Unpaired fronts: ${fr.join(', ')}`,
      `Unpaired backs: ${bk.join(', ')}`,
      ...crossGroupDebug
    ];

    return jsonResponse(200, {
      ok: true,
      pairing: { pairs, products, singletons: [], debugSummary },
      metrics: { images: allKeys.length, fronts: fr.length + pairedF.size, backs: bk.length + pairedB.size, pairs: pairs.length }
    }, originHdr, methods);
  } catch (error: any) {
    console.error("[smartdrafts-pairing] error:", error);
    return jsonResponse(500, {
      error: "Pairing failed",
      message: error?.message || String(error)
    }, originHdr, methods);
  }
};
