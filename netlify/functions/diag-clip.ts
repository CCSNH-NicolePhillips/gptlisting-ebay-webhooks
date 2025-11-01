import type { Handler } from "@netlify/functions";
import { clipTextEmbedding, clipImageEmbedding, cosine } from "../../src/lib/clip-client.js";

export const handler: Handler = async (evt) => {
  try {
    const img = (evt.queryStringParameters?.img || "").trim()
      || "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/transformers/tasks/image_classification.jpeg";

    const text = "BrainMD L-Theanine Gummies berry bottle product photo";
    const t = await clipTextEmbedding(text);
    const i = await clipImageEmbedding(img);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: !!(t && i),
        provider: "hf",
        model: process.env.CLIP_MODEL || "laion/CLIP-ViT-B-32-laion2B-s34B-b79K",
        textDim: t?.length || 0,
        imgDim: i?.length || 0,
        cosine: t && i ? cosine(t, i) : 0,
      }),
    };
  } catch (e: any) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
    };
  }
};
