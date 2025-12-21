import OpenAI from "openai";

/**
 * Perplexity AI client for web-search powered models
 * Uses the same OpenAI SDK but points to Perplexity's API
 * 
 * Models:
 * - sonar-reasoning: Latest reasoning model with web search
 * - sonar: Fast web-search model (cheaper, faster)
 */

const apiKey = process.env.PERPLEXITY_API_KEY;

if (!apiKey) {
  console.warn("[perplexity] Warning: PERPLEXITY_API_KEY not set. Web search calls will be skipped.");
}

export const perplexity = new OpenAI({
  apiKey: apiKey || "",
  baseURL: "https://api.perplexity.ai",
});

export const PERPLEXITY_MODELS = {
  REASONING: "sonar-reasoning", // Most accurate, supports complex queries
  FAST: "sonar", // Faster, cheaper for simple lookups
} as const;
