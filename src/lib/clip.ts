import { getTextEmb, getImageEmb } from "./clip-provider.js";
import { cosine as clientCosine } from "./clip-client.js";

export async function clipTextEmbedding(text: string): Promise<number[] | null> {
  return getTextEmb(text);
}

export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  return getImageEmb(imageUrl);
}

export const cosine = clientCosine;
