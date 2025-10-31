import { Buffer } from "node:buffer";

const HF_API_TOKEN = process.env.HF_API_TOKEN || "";
const CLIP_MODEL = process.env.CLIP_MODEL || "openai/clip-vit-base-patch32";

function toUnit(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector.map(() => 0);
  const inv = 1 / Math.sqrt(norm);
  return vector.map((value) => value * inv);
}

function parseEmbedding(data: any): number[] | null {
  if (!data) return null;
  const source = Array.isArray(data[0]) ? data[0] : data;
  if (!Array.isArray(source)) return null;
  const values = source.map((entry: unknown) => Number(entry) || 0);
  if (!values.length) return null;
  return toUnit(values);
}

async function hfFeatureExtractionJson(input: unknown): Promise<number[] | null> {
  if (!HF_API_TOKEN) return null;
  const url = `https://api-inference.huggingface.co/pipeline/feature-extraction/${CLIP_MODEL}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: input }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn("[clip:text] HF error", res.status, text.slice(0, 200));
    return null;
  }
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return parseEmbedding(payload);
}

async function hfFeatureExtractionBytes(bytes: Uint8Array): Promise<number[] | null> {
  if (!HF_API_TOKEN) return null;
  const url = `https://api-inference.huggingface.co/pipeline/feature-extraction/${CLIP_MODEL}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_API_TOKEN}`,
      "Content-Type": "application/octet-stream",
    },
  body: Buffer.from(bytes),
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn("[clip:image] HF error", res.status, text.slice(0, 200));
    return null;
  }
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return parseEmbedding(payload);
}

export async function clipTextEmbedding(prompt: string): Promise<number[] | null> {
  return hfFeatureExtractionJson(prompt);
}

export async function clipImageEmbeddingFromUrl(imageUrl: string): Promise<number[] | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) {
      console.warn("[clip:image] fetch image failed", res.status, imageUrl);
      return null;
    }
    const buffer = await res.arrayBuffer();
    return hfFeatureExtractionBytes(new Uint8Array(buffer));
  } catch (err: any) {
    console.warn("[clip:image] fetch/bytes error", err?.message || err);
    return null;
  }
}

export function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
