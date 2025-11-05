import { Buffer } from "node:buffer";
import { USE_CLIP } from "../config.js";

const HF_TOKEN = process.env.HF_API_TOKEN || "";
const TEXT_BASE = (process.env.HF_TEXT_ENDPOINT_BASE || "").replace(/\/+$/, "");
const IMAGE_BASE = (process.env.HF_IMAGE_ENDPOINT_BASE || "").replace(/\/+$/, "");

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

function meanPool(mat: number[][]) {
  const r = mat.length;
  const c = mat[0].length;
  const out = new Array<number>(c).fill(0);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) out[j] += mat[i][j] || 0;
  }
  for (let j = 0; j < c; j++) out[j] /= r;
  return out;
}

function normalize(raw: any, pool = false): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw) && typeof raw[0] === "number") return raw as number[];
  if (Array.isArray(raw) && Array.isArray(raw[0]) && typeof raw[0][0] === "number") {
    if (raw.length === 1) return raw[0] as number[];
    return pool ? meanPool(raw as number[][]) : null;
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
  if (!USE_CLIP) {
    return null; // CLIP disabled - return null immediately
  }
  if (!HF_TOKEN || !TEXT_BASE) return null;
  const json = await post(
    TEXT_BASE,
    {
      Authorization: `Bearer ${HF_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    JSON.stringify({ inputs: text })
  );
  const vec = normalize(json, true);
  return vec ? toUnit(vec) : null;
}

export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  if (!USE_CLIP) {
    return null; // CLIP disabled - return null immediately, no HTTP calls
  }
  if (!HF_TOKEN || !IMAGE_BASE) {
    console.warn("[clipImageEmbedding] Missing HF_TOKEN or IMAGE_BASE");
    return null;
  }

  const r = await fetch(imageUrl, { redirect: "follow" });
  if (!r.ok) {
    console.warn(`[clipImageEmbedding] Failed to fetch image: ${r.status} ${r.statusText}`);
    return null;
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  const b64 = typeof Buffer !== "undefined"
    ? Buffer.from(bytes).toString("base64")
    : (globalThis as any).btoa(String.fromCharCode(...bytes));

  try {
    const j1 = await post(
      IMAGE_BASE,
      {
        Authorization: `Bearer ${HF_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      JSON.stringify({ inputs: `data:image/jpeg;base64,${b64}` })
    );
    const v1 = normalize(j1);
    if (v1) return toUnit(v1);
    console.warn(`[clipImageEmbedding] Normalize returned null for base64 attempt. Response:`, j1);
  } catch (err) {
    console.warn(`[clipImageEmbedding] Base64 attempt failed:`, err);
    // continue to fallback
  }

  try {
    const j2 = await post(
      IMAGE_BASE,
      {
        Authorization: `Bearer ${HF_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "image/jpeg",
      },
      bytes
    );
    const v2 = normalize(j2);
    if (v2) return toUnit(v2);
    console.warn(`[clipImageEmbedding] Normalize returned null for binary attempt. Response:`, j2);
  } catch (err) {
    console.warn(`[clipImageEmbedding] Binary attempt failed:`, err);
    // leave null
  }

  return null;
}

export function clipProviderInfo() {
  return { provider: "hf-split-endpoints", textBase: TEXT_BASE, imageBase: IMAGE_BASE };
}
