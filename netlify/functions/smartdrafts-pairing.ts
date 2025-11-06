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
 * Utility: Tokenize string
 */
function tokens(s?: string | null): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

/**
 * Utility: Jaccard similarity
 */
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

/**
 * Utility: Category bucket
 */
function bucket(path?: string | null): string {
  const s = (path || '').toLowerCase();
  if (/supplement|vitamin|nutrition/.test(s)) return 'supp';
  if (/food|beverage|grocery/.test(s)) return 'food';
  if (/hair/.test(s)) return 'hair';
  if (/cosm|skin|spf|make ?up/.test(s)) return 'cosm';
  return 'other';
}

/**
 * Utility: Category compatibility
 */
function categoryCompat(a?: string | null, b?: string | null): number {
  const A = bucket(a);
  const B = bucket(b);
  if (A === B && A !== 'other') return 1.0;
  if ((A === 'hair' && (B === 'supp' || B === 'food')) || (B === 'hair' && (A === 'supp' || A === 'food'))) return -1.0;
  if ((A === 'supp' && B === 'food') || (A === 'food' && B === 'supp')) return 0.4;
  return 0.2; // weak/other
}

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
    const analysis = payload.analysis;

    // CHUNK C.2: Build comprehensive pairing with intra-group + cross-group logic
    
    // 1) Build maps from analysis
    const insights: any[] = Array.isArray(analysis.imageInsights)
      ? analysis.imageInsights
      : Object.values(analysis.imageInsights || {});

    const roleByKey = new Map<string, string>();
    const displayByKey = new Map<string, string>();
    const factsCueByKey = new Map<string, boolean>();
    
    // Helper: detect facts panel cues
    function hasFactsCue(i: any): boolean {
      const ev = (i.evidenceTriggers || []).join(' ').toLowerCase();
      const tx = (i.textExtracted || '').toLowerCase();
      const PAT = /(supplement facts|nutrition facts|drug facts|serving size|other ingredients)/;
      return PAT.test(ev) || PAT.test(tx);
    }
    
    for (const ins of insights) {
      const k = ins.key || urlKey(ins.url);
      if (!k) continue;
      roleByKey.set(k, (ins.role || 'unknown').toLowerCase());
      if (isHttps(ins.displayUrl)) displayByKey.set(k, ins.displayUrl);
      factsCueByKey.set(k, hasFactsCue(ins));
    }

    const brandByKey = new Map<string, string>();
    const productByKey = new Map<string, string>();
    const catByKey = new Map<string, string>();
    
    for (const g of (analysis.groups || [])) {
      const brand = String(g.brand || '').trim();
      const prod = String(g.product || '').trim();
      const cat = String(g.categoryPath || g.category || '').trim();
      for (const img of (g.images || [])) {
        const k = urlKey(img);
        if (brand) brandByKey.set(k, brand);
        if (prod) productByKey.set(k, prod);
        if (cat) catByKey.set(k, cat);
      }
    }

    // 2) Intra-group pairs: promote any front↔back that already coexist in a group
    type Pair = {
      frontUrl: string;
      backUrl: string;
      matchScore: number;
      brand: string;
      product: string;
      variant?: string | null;
      sizeFront?: string | null;
      sizeBack?: string | null;
      evidence: string[];
      confidence: number;
    };

    const autoPairs: Pair[] = [];
    
    for (const g of (analysis.groups || [])) {
      const keys = (g.images || []).map((img: any) => urlKey(img));
      const fronts = keys.filter((k: string) => roleByKey.get(k) === 'front');
      const backs = keys.filter((k: string) => roleByKey.get(k) === 'back');
      
      if (fronts.length && backs.length) {
        const f = fronts[0];
        const b = backs[0];
        autoPairs.push({
          frontUrl: f,
          backUrl: b,
          matchScore: 6.5,
          brand: brandByKey.get(f) || g.brand || '',
          product: productByKey.get(f) || g.product || '',
          variant: g.variant || null,
          sizeFront: g.size || null,
          sizeBack: g.size || null,
          evidence: ['INTRA-GROUP: front/back in same group'],
          confidence: 0.95
        });
      }
    }

    // 3) Cross-group candidates: recover obvious supplement pairs
    function preScore(frontKey: string, backKey: string): number {
      const fBrand = (brandByKey.get(frontKey) || '').toLowerCase();
      const bBrand = (brandByKey.get(backKey) || '').toLowerCase();
      const brandEq = !!fBrand && !!bBrand && fBrand === bBrand;
      
      const prodSim = jaccard(tokens(productByKey.get(frontKey)), tokens(productByKey.get(backKey)));
      const cat = categoryCompat(catByKey.get(frontKey), catByKey.get(backKey));
      
      let s = 0;
      
      // existing components
      if (brandEq) s += 2.0;
      s += prodSim >= 0.6 ? 1.5 : prodSim >= 0.4 ? 1.0 : 0;
      s += cat >= 0.6 ? 1.0 : cat >= 0.2 ? 0.2 : cat <= -0.5 ? -2.0 : 0;
      
      // always reward desired role pairing
      if (roleByKey.get(frontKey) === 'front' && roleByKey.get(backKey) === 'back') s += 1.0;
      
      // --- BOOST: supplement-back rescue boosts ---
      const fBuck = bucket(catByKey.get(frontKey));
      const bBuck = bucket(catByKey.get(backKey));
      
      // (R1) Front is a supplement, back category is unknown/other but is a BACK → modest boost
      if (fBuck === 'supp' && (bBuck === 'other') && roleByKey.get(backKey) === 'back') {
        s += 1.0;
      }
      
      // (R2) Front brand present, back brand missing → small rescue (helps Nusava)
      if (fBrand && !bBrand) {
        s += 0.7;
      }
      
      // (R3) NEW: Supplement back rescue using facts-panel cue
      const backHasFacts = !!factsCueByKey.get(backKey);
      if (fBuck === 'supp' && roleByKey.get(backKey) === 'back' && backHasFacts) {
        s += 1.5;
      }
      
      return s;
    }

    const pairedFronts = new Set(autoPairs.map(p => p.frontUrl));
    const allKeys: string[] = Array.from(new Set(
      (analysis.groups || []).flatMap((g: any) => (g.images || []).map((img: any) => urlKey(img)))
    )) as string[];
    const allFronts = allKeys.filter(k => roleByKey.get(k) === 'front' && !pairedFronts.has(k));
    const allBacks = allKeys.filter(k => roleByKey.get(k) === 'back');

    for (const f of allFronts) {
      const scored = allBacks
        .filter(b => b !== f)
        .map(b => ({ b, s: preScore(f, b) }))
        .sort((x, y) => y.s - x.s);
      
      if (!scored.length) continue;
      
      const best = scored[0];
      const runner = scored[1];
      const gap = best.s - (runner?.s ?? -Infinity);
      
      // Optional debug for Nusava
      if (f === 'rgxbbg.jpg') {
        console.log('[diag nusava]', {
          frontKey: f,
          backKey: best.b,
          s: best.s.toFixed(2),
          backHasFacts: factsCueByKey.get(best.b),
          catFront: catByKey.get(f),
          catBack: catByKey.get(best.b),
          gap: gap === Infinity ? 'Infinity' : gap.toFixed(2)
        });
      }
      
      // Accept if strong enough (strict rule)
      if (best.s >= 3.0 && gap >= 1.0) {
        autoPairs.push({
          frontUrl: f,
          backUrl: best.b,
          matchScore: Math.round(best.s * 100) / 100,
          brand: brandByKey.get(f) || '',
          product: productByKey.get(f) || '',
          variant: null,
          sizeFront: null,
          sizeBack: null,
          evidence: [
            `AUTO-PAIRED: preScore=${best.s.toFixed(2)}`,
            `gap=${gap === Infinity ? 'Infinity' : gap.toFixed(2)}`
          ],
          confidence: 0.95
        });
        continue;
      }
      
      // --- NEW: supplement soft accept ---
      const fBuck = bucket(catByKey.get(f));
      if (fBuck === 'supp' && best.s >= 2.4 && gap >= 0.8) {
        autoPairs.push({
          frontUrl: f,
          backUrl: best.b,
          matchScore: Math.round(best.s * 100) / 100,
          brand: brandByKey.get(f) || '',
          product: productByKey.get(f) || '',
          variant: null,
          sizeFront: null,
          sizeBack: null,
          evidence: [
            `SOFT SUPP RESCUE: preScore=${best.s.toFixed(2)}`,
            `gap=${gap === Infinity ? 'Infinity' : gap.toFixed(2)}`
          ],
          confidence: 0.90
        });
        continue;
      }
    }

    // 4) Run existing pairing logic (if needed) and merge
    const { result, metrics } = await runPairing({
      client,
      analysis: payload.analysis,
      model: "gpt-4o-mini"
    });

    // 5) Canonicalize and merge pairs
    const outPairs: Pair[] = [];
    const seenPairs = new Set<string>();
    
    function pushPair(p: Pair) {
      const k = `${p.frontUrl}|${p.backUrl}`;
      if (seenPairs.has(k)) return;
      seenPairs.add(k);
      outPairs.push(p);
    }

    // Add autoPairs first (higher priority)
    for (const p of autoPairs) pushPair(p);

    // Add existing pairs (canonicalized)
    for (const p of (result.pairs || [])) {
      const canonP = {
        ...p,
        frontUrl: urlKey(p.frontUrl),
        backUrl: urlKey(p.backUrl)
      } as Pair;
      pushPair(canonP);
    }

    // 6) Build products[] with https thumbnails + brand/product
    const products = outPairs.map(p => ({
      productId: `${(brandByKey.get(p.frontUrl) || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${tokens(productByKey.get(p.frontUrl)).join('_')}`.replace(/^_+|_+$/g, '') || `${p.frontUrl}_${p.backUrl}`,
      frontUrl: p.frontUrl,
      backUrl: p.backUrl,
      extras: [],
      evidence: {
        brand: brandByKey.get(p.frontUrl) || '',
        product: productByKey.get(p.frontUrl) || '',
        variant: p.variant || null,
        matchScore: p.matchScore,
        confidence: p.confidence,
        triggers: p.evidence || []
      },
      heroDisplayUrl: displayByKey.get(p.frontUrl) || p.frontUrl,
      backDisplayUrl: displayByKey.get(p.backUrl) || p.backUrl
    }));

    // 7) Populate brand/product on pairs for the table
    for (const p of outPairs) {
      if (!p.brand || p.brand === 'unknown') p.brand = brandByKey.get(p.frontUrl) || p.brand || '';
      if (!p.product || !p.product.length) p.product = productByKey.get(p.frontUrl) || p.product || '';
    }

    // Return final result
    result.pairs = outPairs.map(p => ({
      ...p,
      variant: p.variant ?? null
    })) as any;
    result.products = products;

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
