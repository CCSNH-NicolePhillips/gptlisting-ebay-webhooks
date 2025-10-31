import { Buffer } from "node:buffer";

const HF_API_TOKEN = process.env.HF_API_TOKEN || "";
const CLIP_MODEL = process.env.CLIP_MODEL || "openai/clip-vit-base-patch32";
const HF_BASE_URL = "https://api-inference.huggingface.co/models/";

if (!HF_API_TOKEN) {
  console.warn("[clip] HF_API_TOKEN not set — CLIP scoring disabled");
}

function normalizeEmbedding(raw: any): number[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length && typeof raw[0] === "number") {
    return raw.map((val) => Number(val) || 0);
  }
  if (raw.length && Array.isArray(raw[0])) {
    const first = raw[0] as any[];
    if (first.length && typeof first[0] === "number") {
      return first.map((val) => Number(val) || 0);
    }
  }
  return null;
}

export function toUnit(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector.map(() => 0);
  const inv = 1 / Math.sqrt(norm);
  return vector.map((value) => value * inv);
}

async function postJson(body: unknown): Promise<any> {
  const res = await fetch(`${HF_BASE_URL}${CLIP_MODEL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: body }),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data)) return null;
  return data;
}

export async function clipTextEmbedding(text: string): Promise<number[] | null> {
  if (!HF_API_TOKEN) return null;
  try {
    const raw = await postJson(text);
    const embedding = normalizeEmbedding(raw);
    return embedding ? toUnit(embedding) : null;
  } catch (err) {
    console.warn("[clip] text embedding failed", err);
    return null;
  }
}

export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  if (!HF_API_TOKEN) return null;
  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) return null;
    const arrayBuffer = await imageResponse.arrayBuffer();
    const res = await fetch(`${HF_BASE_URL}${CLIP_MODEL}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_API_TOKEN}`,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(arrayBuffer),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(data)) return null;
    const embedding = normalizeEmbedding(data);
    return embedding ? toUnit(embedding) : null;
  } catch (err) {
    console.warn("[clip] image embedding failed", err);
    return null;
  }
}

export function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
