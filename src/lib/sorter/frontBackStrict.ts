// frontBackStrict.ts
export type RoleInfo = { role?: "front"|"back"|null; hasVisibleText?: boolean; ocr?: string };
export type Insight = { url: string; role: "front"|"back"|null; hasVisibleText: boolean; keep: boolean; ocr?: string; reason?: string };

export interface SorterDeps {
  getOCRForUrl: (url: string)=> Promise<string>;         // you already have this/cache
  clipTextEmbedding: (t: string)=> Promise<number[]|null>;
  clipImageEmbedding: (u: string)=> Promise<number[]|null>;
  cosine: (a:number[],b:number[])=> number;
}

const BACK_MIN_SIM   = Number(process.env.BACK_MIN_SIM ?? 0.35);
const OUTLIER_MIN_SIM= Number(process.env.OUTLIER_MIN_SIM ?? 0.35);
const OCR_BRAND_MIN  = Number(process.env.OCR_BRAND_MIN ?? 1);

const backHints = ["back","facts","ingredients","nutrition","supplement","drug"];
const factsRe   = /supplement facts|nutrition facts|ingredients|drug facts|directions/i;

function base(u: string){ const s=u.split("?")[0]; return s.substring(s.lastIndexOf("/")+1).toLowerCase(); }
function brandScore(ocr:string, tokens:string[]){ const s=(ocr||"").toLowerCase(); let sc=0; for(const t of tokens) if(t && s.includes(t)) sc++; return sc; }

export async function frontBackStrict(
  folderUrls: string[],
  imageInsights: RoleInfo[],        // from vision (may be empty)
  groupSeed: { brand?: string; product?: string; variant?: string; size?: string },
  deps: SorterDeps
): Promise<{images:string[], heroUrl?:string|null, backUrl?:string|null, debug:any}> {

  // 0) index insights by basename
  const roleByBase = new Map<string, RoleInfo>();
  for (const ins of (imageInsights||[])) roleByBase.set(base((ins as any).url || (ins as any).path || ""), ins);

  // 1) build snapshot (folder-only) with role + OCR
  const metas = await Promise.all(folderUrls.map(async url => {
    const b   = base(url);
    const inf = roleByBase.get(b) || {};
    const ocr = inf.ocr ?? await deps.getOCRForUrl(url) ?? "";
    const hasText = inf.hasVisibleText ?? (ocr.length>0);
    const fileBack = backHints.some(k => b.includes(k));
    const ocrBack  = factsRe.test(ocr);
    return { url, b, role: (inf.role ?? null) as ("front"|"back"|null), ocr, hasText, fileBack, ocrBack };
  }));

  // 2) tokens for brand gating (not mandatory)
  const tokens = [groupSeed.brand, groupSeed.product].filter(Boolean).map(x => (x||"").toLowerCase());

  // 3) FRONT: role 'front' > brand OCR > hasText > first
  let front = metas.find(m => m.role==="front")
         || metas.slice().sort((a,b)=> brandScore(b.ocr,tokens)-brandScore(a.ocr,tokens) || Number(b.hasText)-Number(a.hasText))[0]
         || metas[0];

  // 4) BACK: role 'back' > OCR facts words > CLIP-to-front (≥ BACK_MIN_SIM)
  let back = metas.find(m => m.url!==front.url && m.role==="back")
        || metas.filter(m => m.url!==front.url).sort((a,b)=> Number(b.ocrBack)-Number(a.ocrBack) || brandScore(b.ocr,tokens)-brandScore(a.ocr,tokens))[0];

  if (!back) {
    const seedV = await deps.clipImageEmbedding(front.url);
    if (seedV) {
      const scored = await Promise.all(
        metas.filter(m=>m.url!==front.url).map(async m=>{
          const v = await deps.clipImageEmbedding(m.url);
          const s = (v && v.length===seedV.length) ? deps.cosine(v, seedV) : 0;
          return { m, s };
        })
      );
      scored.sort((a,b)=> b.s-a.s);
      if (scored[0]?.s >= BACK_MIN_SIM) back = scored[0].m;
    }
  }

  // 5) Outlier drop vs. front (dog/purse)
  const fV = await deps.clipImageEmbedding(front.url).catch(()=>null);
  const ok = async (url:string) => {
    if (!fV) return true;
    const v = await deps.clipImageEmbedding(url).catch(()=>null);
    const s = (v && v.length===fV.length) ? deps.cosine(v, fV) : 0;
    return s >= OUTLIER_MIN_SIM;
  };

  const out: string[] = [];
  if (await ok(front.url)) out.push(front.url);
  if (back && back.url!==front.url && await ok(back.url)) out.push(back.url);

  return { images: out.slice(0,2), heroUrl: out[0]||null, backUrl: out[1]||null,
           debug: { metas: metas.map(m=>({url:m.url, role:m.role, ocrBack:m.ocrBack, hasText:m.hasText})) } };
}
