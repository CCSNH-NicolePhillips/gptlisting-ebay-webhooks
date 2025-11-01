import type { Handler } from "@netlify/functions";
import { clipTextEmbedding, clipImageEmbedding, cosine, clipProviderInfo } from "../../src/lib/clip-client.js";

export const handler: Handler = async (evt) => {
  const img = evt.queryStringParameters?.img || "https://picsum.photos/512";
  const t = await clipTextEmbedding("BrainMD L-Theanine Gummies bottle photo");
  const i = await clipImageEmbedding(img);
  const info = clipProviderInfo();
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: !!(t && i && t.length === i.length && t.length > 0),
      ...info,
      textDim: t?.length || 0,
      imgDim: i?.length || 0,
      cosine: t && i ? cosine(t, i) : 0,
    }),
  };
};
