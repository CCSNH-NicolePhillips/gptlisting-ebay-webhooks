type Provider = "openai" | "anthropic" | "google";

type VisionModel = {
  provider: Provider;
  name: string;
};

type VisionInput = {
  images: string[];
  prompt: string;
};

function normalizeImages(images: string[] | undefined | null): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .map((url) => (typeof url === "string" ? url.trim() : ""))
    .filter(Boolean);
}

function coerceProvider(value: string | undefined | null): Provider {
  const normalized = (value || "openai").toLowerCase();
  if (normalized.startsWith("anthropic")) return "anthropic";
  if (normalized.startsWith("google")) return "google";
  return "openai";
}

function parseModel(model?: string): VisionModel {
  const fallbackProvider: Provider = "openai";
  const fallbackName = "gpt-4o-mini";
  const raw = (model || `${fallbackProvider}:${fallbackName}`).trim();
  const [providerPart, ...rest] = raw.split(":");
  const provider = coerceProvider(providerPart);
  const nameCandidate = rest.length ? rest.join(":") : provider === "openai" ? raw : fallbackName;
  const name = nameCandidate.trim() || fallbackName;
  return { provider, name };
}

async function tryOpenAI(images: string[], prompt: string, model: string) {
  const { openai } = await import("./openai.js");
  const content: any[] = [{ type: "text", text: prompt }];
  for (const url of images) {
    content.push({ type: "image_url", image_url: { url } });
  }
  const response = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 4000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a strict JSON-only product photo parser. You MUST include all required fields in your response, especially visualDescription for every image." },
      { role: "user", content },
    ],
  });
  const payload = response.choices?.[0]?.message?.content || "{}";
  return JSON.parse(payload);
}

async function tryAnthropic(images: string[], prompt: string, model: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key missing");
  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: "Return ONLY valid JSON.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...images.map((url) => ({
            type: "image",
            source: {
              type: "url",
              url,
              // SDK currently requires data/media_type for base64 sources; URL fetch support is evolving.
            },
          } as any)),
        ],
      },
    ],
  });
  const text = (response.content?.[0] as any)?.text || "{}";
  return JSON.parse(text);
}

async function tryGoogle(images: string[], prompt: string, model: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key missing");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const generativeModel = genAI.getGenerativeModel({ 
    model,
  });
  const parts: any[] = [{ text: prompt }];
  
  for (const url of images) {
    // Handle base64 data URLs
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    } else {
      // For regular URLs, Gemini can fetch them directly
      parts.push({
        fileData: {
          mimeType: "image/jpeg",
          fileUri: url,
        },
      });
    }
  }
  
  const response = await generativeModel.generateContent({
    contents: [{ role: "user", parts }],
  });
  const raw = response.response.text() || "{}";
  const jsonLike = raw.trim().replace(/```json|```/g, "");
  return JSON.parse(jsonLike);
}

/**
 * Phase 4A: Check if error is a rate limit
 */
function isRateLimit(err: any): boolean {
  if (!err) return false;
  // Check status code
  if (err.status === 429) return true;
  // Check error type
  if (err.type === "tokens" || err.code === "rate_limit_exceeded") return true;
  // Check message
  const msg = String(err.message || err.error || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("tpm") || msg.includes("tokens per min");
}

/**
 * Phase 4A: Automatic Vision Fallback (gpt-4o → gpt-4o-mini → retry gpt-4o)
 */
export async function runVision(input: VisionInput): Promise<any> {
  const images = normalizeImages(input.images);
  const prompt = input.prompt || "";

  // Default to gpt-4o-mini as the primary workhorse (cheaper, faster, good enough for most vision tasks)
  const primaryModel = process.env.VISION_MODEL || "openai:gpt-4o-mini";
  const primary = parseModel(primaryModel);
  
  console.log(`[vision-router] Using ${primaryModel}`);

  // Try primary model first
  try {
    if (primary.provider === "openai") {
      console.log(`[vision-router] Attempting OpenAI with model: ${primary.name}`);
      const result = await tryOpenAI(images, prompt, primary.name);
      return result;
    }
    if (primary.provider === "anthropic") {
      console.log(`[vision-router] Attempting Anthropic with model: ${primary.name}`);
      return await tryAnthropic(images, prompt, primary.name);
    }
    if (primary.provider === "google") {
      console.log(`[vision-router] Attempting Google with model: ${primary.name}`);
      return await tryGoogle(images, prompt, primary.name);
    }
  } catch (err: any) {
    console.error(`[vision-router] ❌ ${primary.provider} (${primary.name}) failed:`, {
      status: err?.status,
      code: err?.code,
      type: err?.type,
      message: err?.message,
      error: err?.error?.message || err?.error,
    });

    // Phase 4A: If rate limit and primary is gpt-4o, fallback to gpt-4o-mini
    if (isRateLimit(err) && primary.provider === "openai" && primary.name === "gpt-4o") {
      console.warn(`[vision-fallback] gpt-4o hit rate limit, switching to gpt-4o-mini`);
      try {
        const result = await tryOpenAI(images, prompt, "gpt-4o-mini");
        (result as any)._modelUsed = "gpt-4o-mini";
        console.log(`[vision-fallback] ✅ Successfully used gpt-4o-mini fallback`);
        return result;
      } catch (fallbackErr: any) {
        console.error(`[vision-fallback] ❌ gpt-4o-mini also failed:`, {
          status: fallbackErr?.status,
          message: fallbackErr?.message,
        });
        throw fallbackErr;
      }
    }

    // If rate limit on gpt-4o-mini (primary), don't try it again - go straight to other providers
    if (isRateLimit(err) && primary.provider === "openai" && primary.name === "gpt-4o-mini") {
      console.warn(`[vision-fallback] gpt-4o-mini hit rate limit, skipping to other providers`);
      // Continue to fallback providers below
    }

    // Not a rate limit or not OpenAI, try configured fallbacks
    // Track which models we've already tried to avoid retrying rate-limited models
    const triedModels = new Set<string>([`${primary.provider}:${primary.name}`]);
    
    const envFallbacks = (process.env.VISION_FALLBACK || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(parseModel);
    
    const defaultFallbacks: VisionModel[] = envFallbacks.length
      ? []
      : [parseModel("anthropic:claude-3-5-sonnet"), parseModel("google:gemini-1.5-flash")];
    
    const fallbacks = [...envFallbacks, ...defaultFallbacks];
    let lastError = err;

    for (const attempt of fallbacks) {
      const { provider, name } = attempt;
      const modelKey = `${provider}:${name}`;
      
      // Skip models we've already tried (especially ones that rate limited)
      if (triedModels.has(modelKey)) {
        console.log(`[vision-router] Skipping ${modelKey} (already tried)`);
        continue;
      }
      
      triedModels.add(modelKey);
      
      try {
        if (provider === "openai") {
          console.log(`[vision-router] Attempting OpenAI with model: ${name}`);
          return await tryOpenAI(images, prompt, name);
        }
        if (provider === "anthropic") {
          console.log(`[vision-router] Attempting Anthropic with model: ${name}`);
          return await tryAnthropic(images, prompt, name);
        }
        if (provider === "google") {
          console.log(`[vision-router] Attempting Google with model: ${name}`);
          return await tryGoogle(images, prompt, name);
        }
      } catch (attemptErr: any) {
        console.error(`[vision-router] ❌ ${provider} (${name}) failed:`, {
          status: attemptErr?.status,
          code: attemptErr?.code,
          type: attemptErr?.type,
          message: attemptErr?.message,
          error: attemptErr?.error?.message || attemptErr?.error,
        });
        lastError = attemptErr;
        continue;
      }
    }

    throw lastError;
  }

  throw new Error("Vision provider not recognized");
}
