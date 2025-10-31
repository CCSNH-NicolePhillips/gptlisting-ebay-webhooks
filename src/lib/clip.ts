import { getTextEmb, getImageEmb, cosine as providerCosine } from "./clip-provider.js";

export async function clipTextEmbedding(text: string): Promise<number[] | null> {
  return getTextEmb(text);
}

export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  return getImageEmb(imageUrl);
}

export const cosine = providerCosine;
