// src/lib/clip-client.ts
const HF_API_TOKEN = process.env.HF_API_TOKEN || "";
const CLIP_MODEL = process.env.CLIP_MODEL || "laion/CLIP-ViT-B-32-laion2B-s34B-b79K";
const HF_BASE = "https://api-inference.huggingface.co";

// ---- math helpers ----
function meanPool2D(mat: number[][]): number[] {
  const rows = mat.length;
  const cols = mat[0]?.length || 0;
  const out = new Array<number>(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out[c] += mat[r][c] || 0;
    }
  }
  const inv = rows ? 1 / rows : 0;
  for (let c = 0; c < cols; c++) {
    out[c] *= inv;
  }
  return out;
}

export function toUnit(vec: number[]): number[] {
  let n = 0;
  for (const v of vec) n += v * v;
  if (!n) return vec.map(() => 0);
  const inv = 1 / Math.sqrt(n);
  return vec.map((value) => value * inv);
}

export function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

// Accept 1D [512], 2D [[512]] or 2D [seq_len,512]. If pool=true, mean-pool rows.
function normalizeEmbedding(raw: any, { pool = false }: { pool?: boolean } = {}): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
    return raw as number[];
  }
  if (Array.isArray(raw) && Array.isArray(raw[0]) && typeof raw[0][0] === "number") {
    const mat = raw as number[][];
    if (mat.length === 0) return null;
    if (mat.length === 1) return mat[0];
    return pool ? meanPool2D(mat) : null;
  }
  if (raw && Array.isArray(raw.embeddings)) {
    return normalizeEmbedding(raw.embeddings, { pool });
  }
  return null;
}

async function hfFetch(path: string, init: RequestInit, retries = 2): Promise<any> {
  const url = `${HF_BASE}/${path}/${encodeURIComponent(CLIP_MODEL)}?wait_for_model=true`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${HF_API_TOKEN}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (res.status === 503 && retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return hfFetch(path, init, retries - 1);
    }
    throw new Error(`HF ${res.status}: ${txt || res.statusText}`);
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function clipTextEmbedding(text: string): Promise<number[] | null> {
  if (!HF_API_TOKEN) return null;
  try {
    const out = await hfFetch("pipeline/feature-extraction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: text }),
    });
    const emb = normalizeEmbedding(out, { pool: true });
    return emb ? toUnit(emb) : null;
  } catch (err) {
    console.warn("[clip] text embedding failed:", err);
    return null;
  }
}

export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  if (!HF_API_TOKEN) return null;
  try {
    const imgRes = await fetch(imageUrl, { redirect: "follow" });
    if (!imgRes.ok) throw new Error(`image fetch ${imgRes.status}`);
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    const out = await hfFetch("pipeline/feature-extraction", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    const emb = normalizeEmbedding(out);
    return emb ? toUnit(emb) : null;
  } catch (err) {
    console.warn("[clip] image embedding failed:", err);
    return null;
  }
}
