import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  // We will wire real calls in a later chunk; keep dev experience smooth for now.
  console.warn("[openai] Warning: OPENAI_API_KEY is not set. Vision calls will fail once enabled.");
}

export const openai = new OpenAI({
  apiKey: apiKey || "unset",
});
