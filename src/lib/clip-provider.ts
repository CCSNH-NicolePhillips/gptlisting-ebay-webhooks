import { clipTextEmbedding, clipImageEmbedding } from "./clip-client.js";
import { getCached, putCached, textKey, imageKey } from "./clip-cache.js";
import { toDirectDropbox } from "./merge.js";

const PROVIDER = (process.env.CLIP_PROVIDER || "hf").toLowerCase();
const ENABLED = PROVIDER !== "off";
const HF_PROVIDER = "hf";

export async function getTextVector_HF(text: string): Promise<number[] | null> {
  const key = textKey(text);
  const cached = await getCached(key);
  if (cached) return cached;
  const embedding = await clipTextEmbedding(text);
  if (embedding) await putCached(key, embedding);
  return embedding;
}

export async function getImageVector_HF(url: string): Promise<number[] | null> {
  const direct = toDirectDropbox(url);
  const key = imageKey(direct);
  const cached = await getCached(key);
  if (cached) return cached;
  const embedding = await clipImageEmbedding(direct);
  if (embedding) await putCached(key, embedding);
  return embedding;
}

export async function getTextEmb(text: string): Promise<number[] | null> {
  if (!ENABLED) return null;
  if (PROVIDER === HF_PROVIDER) {
    return getTextVector_HF(text);
  }
  return null;
}

export async function getImageEmb(url: string): Promise<number[] | null> {
  if (!ENABLED) return null;
  if (PROVIDER === HF_PROVIDER) {
    return getImageVector_HF(url);
  }
  return null;
}
