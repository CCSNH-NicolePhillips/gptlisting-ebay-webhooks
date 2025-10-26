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
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a strict JSON-only product photo parser." },
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
  const generativeModel = genAI.getGenerativeModel({ model });
  const parts: any[] = [{ text: prompt }];
  for (const url of images) {
    parts.push({ text: `Image URL: ${url}` });
  }
  const response = await generativeModel.generateContent({
    contents: [{ role: "user", parts }],
  });
  const raw = response.response.text() || "{}";
  const jsonLike = raw.trim().replace(/```json|```/g, "");
  return JSON.parse(jsonLike);
}

export async function runVision(input: VisionInput): Promise<any> {
  const images = normalizeImages(input.images);
  const prompt = input.prompt || "";

  const primary = parseModel(process.env.VISION_MODEL);
  const fallbacks = (process.env.VISION_FALLBACK || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseModel);

  const attempts = [primary, ...fallbacks];

  let lastError: unknown;

  for (const attempt of attempts) {
    const { provider, name } = attempt;
    try {
      if (provider === "openai") {
        return await tryOpenAI(images, prompt, name);
      }
      if (provider === "anthropic") {
        return await tryAnthropic(images, prompt, name);
      }
      if (provider === "google") {
        return await tryGoogle(images, prompt, name);
      }
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("All vision providers failed");
}
