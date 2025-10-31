import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_TEXT_MODEL = process.env.OPENAI_CLIP_TEXT_MODEL || "text-embedding-3-small";
const DEFAULT_IMAGE_MODEL = process.env.OPENAI_CLIP_IMAGE_MODEL || "gpt-4o-mini-embed";

const openaiClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

if (!OPENAI_API_KEY) {
  console.warn("[clip] OPENAI_API_KEY not set — CLIP scoring disabled");
}

function normalizeEmbedding(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw) && raw.length && typeof raw[0] === "number") {
    return raw.map((val) => Number(val) || 0);
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

export async function clipTextEmbedding(text: string): Promise<number[] | null> {
  if (!openaiClient) return null;
  try {
    const response = await openaiClient.embeddings.create({
      model: DEFAULT_TEXT_MODEL,
      input: text,
    });
    const embedding = response.data?.[0]?.embedding;
    return embedding ? toUnit(embedding) : null;
  } catch (err) {
    console.warn("[clip] text embedding failed", err);
    return null;
  }
}

export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  if (!openaiClient) return null;
  try {
    const client: any = openaiClient;
    if (!client?.images?.embeddings) {
      console.warn("[clip] openai.images.embeddings unavailable");
      return null;
    }
    const response = await client.images.embeddings({
      model: DEFAULT_IMAGE_MODEL,
      image: imageUrl,
    });
    const embedding = response?.data?.[0]?.embedding;
    return Array.isArray(embedding) ? toUnit(embedding as number[]) : null;
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
