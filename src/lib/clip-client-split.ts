import { Buffer } from "node:buffer";

const HF_TOKEN = process.env.HF_API_TOKEN || "";
const TEXT_BASE = (process.env.HF_TEXT_ENDPOINT_BASE || "").replace(/\/+$/, "");
const IMAGE_BASE = (process.env.HF_IMAGE_ENDPOINT_BASE || "").replace(/\/+$/, "");
const CLIP_MODEL = process.env.CLIP_MODEL || "";

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

function normalize(raw: any, pool = false): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw) && typeof raw[0] === "number") return raw as number[];
  if (Array.isArray(raw) && Array.isArray(raw[0]) && typeof raw[0][0] === "number") {
    const mat = raw as number[][];
    if (mat.length === 1) return mat[0];
    if (!pool) return null;
    const rows = mat.length;
    const cols = mat[0].length;
    const out = new Array<number>(cols).fill(0);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) out[c] += mat[r][c] || 0;
    }
    for (let c = 0; c < cols; c++) out[c] /= rows || 1;
    return out;
  }
  if (raw && Array.isArray(raw.embeddings)) return normalize(raw.embeddings, pool);
  if (raw && Array.isArray(raw.embedding)) return normalize(raw.embedding, pool);
  return null;
}

async function post(url: string, headers: Record<string, string>, body: BodyInit) {
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${text}`);
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function clipTextEmbedding(text: string): Promise<number[] | null> {
  const base = TEXT_BASE;
  const token = HF_TOKEN;
  if (!base || !token) return null;
  const json = await post(
    base,
    {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    JSON.stringify({ inputs: text })
  );
  const vec = normalize(json, true);
  return vec ? toUnit(vec) : null;
}

export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  const base = IMAGE_BASE;
  const token = HF_TOKEN;
  if (!base || !token) return null;

  const r = await fetch(imageUrl, { redirect: "follow" });
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  const b64 = typeof Buffer !== "undefined"
    ? Buffer.from(bytes).toString("base64")
    : (globalThis as any).btoa(String.fromCharCode(...bytes));

  try {
    const json1 = await post(
      base,
      {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      JSON.stringify({ inputs: `data:image/jpeg;base64,${b64}` })
    );
    const v1 = normalize(json1);
    if (v1) return toUnit(v1);
  } catch {
    // continue to fallback
  }

  try {
    const json2 = await post(
      base,
      {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "image/jpeg",
      },
      bytes
    );
    const v2 = normalize(json2);
    if (v2) return toUnit(v2);
  } catch {
    // leave null
  }

  return null;
}

export function clipProviderInfo() {
  return {
    provider: "hf-single-endpoint",
    model: CLIP_MODEL,
    base: TEXT_BASE,
  };
}
