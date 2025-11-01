// src/lib/clip-client.ts
const HF_API_TOKEN = process.env.HF_API_TOKEN || "";
const CLIP_MODEL = process.env.CLIP_MODEL || "laion/CLIP-ViT-B-32-DataComp.XL-s13B-b90K";
// Private endpoint base provided by user; fallback to serverless (not recommended)
const HF_ENDPOINT_BASE = (process.env.HF_ENDPOINT_BASE || "https://api-inference.huggingface.co").replace(/\/+$/, "");

function meanPool2D(mat: number[][]): number[] {
  const rows = mat.length;
  const cols = mat[0]?.length || 0;
  const out = new Array<number>(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out[c] += mat[r][c] || 0;
  }
  const inv = rows ? 1 / rows : 0;
  for (let c = 0; c < cols; c++) out[c] *= inv;
  return out;
}

function toUnit(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  if (!n) return v.map(() => 0);
  const inv = 1 / Math.sqrt(n);
  return v.map((x) => x * inv);
}

export function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

// Accept [512], [[512]] or [seq_len,512]. pool=true mean-pools the first dimension.
function normalizeEmbedding(raw: any, { pool = false }: { pool?: boolean } = {}): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") return raw as number[];
  if (Array.isArray(raw) && Array.isArray(raw[0]) && typeof raw[0][0] === "number") {
    const mat = raw as number[][];
    if (mat.length === 1) return mat[0];
    return pool ? meanPool2D(mat) : null;
  }
  if (raw && Array.isArray(raw.embeddings)) return normalizeEmbedding(raw.embeddings, { pool });
  return null;
}

async function hfCall(body: BodyInit, contentType: string, retries = 2): Promise<any> {
  // For HF Inference Endpoint, the route is <BASE>/models/<MODEL>
  const url = `${HF_ENDPOINT_BASE}/models/${encodeURIComponent(CLIP_MODEL)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_API_TOKEN}`,
      "Content-Type": contentType,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 503 && retries > 0) {
      await new Promise((r) => setTimeout(r, 700));
      return hfCall(body, contentType, retries - 1);
    }
    throw new Error(`HF ${res.status}: ${text || res.statusText}`);
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function clipTextEmbedding(text: string): Promise<number[] | null> {
  if (!HF_API_TOKEN) return null;
  const payload = JSON.stringify({ inputs: text, options: { wait_for_model: true } });
  const out = await hfCall(payload, "application/json");
  const vec = normalizeEmbedding(out, { pool: true });
  return vec ? toUnit(vec) : null;
}

export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  if (!HF_API_TOKEN) return null;
  const imgRes = await fetch(imageUrl, { redirect: "follow" });
  if (!imgRes.ok) return null;
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  const out = await hfCall(bytes, "application/octet-stream");
  const vec = normalizeEmbedding(out);
  return vec ? toUnit(vec) : null;
}

// Optional introspection for debug blocks
export function clipProviderInfo() {
  return {
    provider: "hf-private-endpoint",
    model: CLIP_MODEL,
    base: HF_ENDPOINT_BASE,
  };
}
