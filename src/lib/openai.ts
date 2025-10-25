import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.warn("[openai] Warning: OPENAI_API_KEY not set. Vision calls will fail.");
}

export const openai = new OpenAI({
  apiKey: apiKey || "",
  defaultHeaders: { "User-Agent": "ebaywebhooks-product-analyzer/1.0" },
});
