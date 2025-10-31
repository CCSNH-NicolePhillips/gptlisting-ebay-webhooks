import { clipTextEmbedding, clipImageEmbeddingFromUrl, cosine as clipCosine } from "./clip-client.js";
import { getCached, putCached, textKey, imageKey } from "./clip-cache.js";
import { toDirectDropbox } from "./merge.js";

const PROVIDER = (process.env.CLIP_PROVIDER || "hf").toLowerCase();
const ENABLED = PROVIDER !== "off";

export async function getTextEmb(text: string): Promise<number[] | null> {
  if (!ENABLED) return null;
  const key = textKey(text);
  const cached = await getCached(key);
  if (cached) return cached;
  const embedding = await clipTextEmbedding(text);
  if (embedding) await putCached(key, embedding);
  return embedding;
}

export async function getImageEmb(url: string): Promise<number[] | null> {
  if (!ENABLED) return null;
  const direct = toDirectDropbox(url);
  const key = imageKey(direct);
  const cached = await getCached(key);
  if (cached) return cached;
  const embedding = await clipImageEmbeddingFromUrl(direct);
  if (embedding) await putCached(key, embedding);
  return embedding;
}

export const cosine = clipCosine;
