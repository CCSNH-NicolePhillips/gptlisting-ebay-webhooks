import type { Handler } from '../../src/types/api-handler.js';
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";
import { pickCategoryForGroup } from "../../src/lib/taxonomy-select.js";
import { openai } from "../../src/lib/openai.js";

const METHODS = "POST, OPTIONS";
const MODEL = process.env.GPT_MODEL || "gpt-3.5-turbo";
const MAX_TOKENS = Number(process.env.GPT_MAX_TOKENS || 700);
const GPT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.GPT_RETRY_ATTEMPTS || 2));
const GPT_RETRY_DELAY_MS = Math.max(250, Number(process.env.GPT_RETRY_DELAY_MS || 1500));

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Seed = {
  id?: string;
  brand?: string;
  product: string;
  variant?: string;
  size?: string;
  features?: string[];
  keywords?: string[];
  price?: number;
  folder?: string;
  groupName?: string;
  options?: Record<string, string[]>;
};

type Draft = {
  id?: string;
  title: string;
  bullets: string[];
  description: string;
  aspects: Record<string, string[]>;
  category: { id?: string; name?: string };
};

function sanitizeString(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function sanitizeStringArray(value: unknown, maxItems = 12): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((entry: unknown) => sanitizeString(entry))
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (!out.length) return undefined;
  const deduped = Array.from(new Set(out));
  return deduped.slice(0, maxItems);
}

function sanitizeOptionMap(value: unknown, maxItemsPerKey = 10): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string[]> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, raw]) => {
    const name = sanitizeString(key, 80);
    if (!name) return;
    const arr = Array.isArray(raw) ? raw : [raw];
    const sanitized = arr
      .map((entry: unknown) => sanitizeString(entry, 160))
      .filter((entry): entry is string => typeof entry === "string");
    if (!sanitized.length) return;
    out[name] = Array.from(new Set(sanitized)).slice(0, maxItemsPerKey);
  });
  return Object.keys(out).length ? out : undefined;
}

function dedupeStrings(list: string[]): string[] {
  return Array.from(new Set(list));
}

function sanitizePrice(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.round(num * 100) / 100;
}

function normalizeSeed(input: any): Seed | null {
  if (!input || typeof input !== "object") return null;
  const product = sanitizeString((input as any).product, 200);
  if (!product) return null;
  const seed: Seed = {
    product,
    id: sanitizeString((input as any).id, 80),
    brand: sanitizeString((input as any).brand, 120),
    variant: sanitizeString((input as any).variant, 120),
    size: sanitizeString((input as any).size, 80),
    features: sanitizeStringArray((input as any).features, 16),
    keywords: sanitizeStringArray((input as any).keywords, 20),
    price: sanitizePrice((input as any).price),
    folder: sanitizeString((input as any).folder, 240),
    groupName: sanitizeString((input as any).groupName, 160),
    options: sanitizeOptionMap((input as any).options),
  };
  return seed;
}

async function callOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= GPT_RETRY_ATTEMPTS; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.7,
        max_tokens: Math.max(100, Math.min(4000, MAX_TOKENS || 700)),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an expert eBay listing writer.\nReturn ONLY strict JSON with keys: title, bullets, description, aspects, category.\n- title: <=80 chars, high-signal, no emojis, no fluff.\n- bullets: array of 3 short points.\n- description: 2-4 sentences, neutral claims (no medical).\n- aspects: include Brand if given; use keys like Brand, Flavor, Size, Type, Features.\n- category: {name:\"<best>\", id:\"\"} (leave id blank if unsure).",
          },
          { role: "user", content: prompt },
        ],
      });
      return completion.choices?.[0]?.message?.content || "{}";
    } catch (err) {
      lastError = err;
      if (attempt >= GPT_RETRY_ATTEMPTS) break;
      const delay = GPT_RETRY_DELAY_MS * attempt;
      await sleep(delay);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError || "OpenAI error");
  throw new Error(message);
}

function buildPrompt(seed: Seed, categoryHint: { id: string; title: string } | null) {
  const lines = [
    `Brand: ${seed.brand || "Unknown"}`,
    `Product: ${seed.product}`,
  ];
  if (seed.groupName && seed.groupName !== seed.product) {
    lines.push(`Group name: ${seed.groupName}`);
  }
  if (seed.folder) {
    lines.push(`Folder path: ${seed.folder}`);
  }
  if (seed.variant) {
    lines.push(`Variant: ${seed.variant}`);
  }
  if (seed.size) {
    lines.push(`Size: ${seed.size}`);
  }
  if (seed.features?.length) {
    lines.push(`Features: ${seed.features.join(", ")}`);
  }
  if (seed.options && Object.keys(seed.options).length) {
    const specifics = Object.entries(seed.options)
      .map(([key, values]) => `${key}: ${values.join(" | ")}`)
      .join("; ");
    if (specifics) {
      lines.push(`Detected specifics: ${specifics}`);
    }
  }
  if (seed.keywords?.length) {
    lines.push(`Keywords: ${seed.keywords.join(", ")}`);
  }
  if (typeof seed.price === "number") {
    lines.push(`Price hint: $${seed.price.toFixed(2)}`);
  }
  if (categoryHint) {
    lines.push(`Suggested eBay category: ${categoryHint.title} (${categoryHint.id})`);
  }
  lines.push("Fill optional fields when present, keep tone factual.");
  return `Create an eBay-ready draft from:\n${lines.join("\n")}`;
}

function normalizeAspects(input: unknown): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  if (!input || typeof input !== "object") return aspects;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const name = sanitizeString(key, 80);
    if (!name) continue;
    const arr = Array.isArray(value) ? value : [value];
    const sanitized = arr
      .map((entry: unknown) => sanitizeString(entry, 160))
      .filter((entry): entry is string => typeof entry === "string");
    if (sanitized.length) {
      aspects[name] = Array.from(new Set(sanitized)).slice(0, 10);
    }
  }
  return aspects;
}

function mergeBrandAspect(aspects: Record<string, string[]>, brand?: string) {
  if (!brand) return aspects;
  const current = aspects.Brand || [];
  if (current.includes(brand)) return aspects;
  aspects.Brand = [brand, ...current].slice(0, 3);
  return aspects;
}

function ensureSizeAspect(aspects: Record<string, string[]>, size?: string) {
  if (!size) return aspects;
  const current = aspects.Size || [];
  if (current.includes(size)) return aspects;
  aspects.Size = [size, ...current].slice(0, 3);
  return aspects;
}

async function categoryHintForSeed(seed: Seed) {
  try {
    const category = await pickCategoryForGroup({
      brand: seed.brand,
      product: seed.product,
      variant: seed.variant,
      size: seed.size,
      claims: seed.features,
      keywords: seed.keywords,
    });
    if (!category) return null;
    return { id: category.id, title: category.title };
  } catch (err) {
    console.warn("[ai-gpt-drafts] category suggestion failed", err);
    return null;
  }
}

function buildDraft(seed: Seed, json: any, categoryHint: { id: string; title: string } | null): Draft {
  const title = sanitizeString(json?.title, 80) || `${seed.brand ? `${seed.brand} ` : ""}${seed.product}`.slice(0, 80);
  const rawBullets = Array.isArray(json?.bullets) ? json.bullets : [];
  const bullets = rawBullets
    .map((entry: unknown) => sanitizeString(entry, 200))
    .filter((entry: any): entry is string => typeof entry === "string")
    .slice(0, 3);
  if (bullets.length < 3) {
    const extras = dedupeStrings([...(seed.features || []), ...(seed.keywords || [])]).map((entry) =>
      entry.slice(0, 200),
    );
    extras.forEach((extra) => {
      if (bullets.length < 3 && extra) bullets.push(extra);
    });
  }
  const description = sanitizeString(json?.description, 1200) || `${title}.`;
  const aspects = ensureSizeAspect(mergeBrandAspect(normalizeAspects(json?.aspects), seed.brand), seed.size);
  const rawCategory = json?.category && typeof json.category === "object" ? json.category : {};
  const categoryName = sanitizeString((rawCategory as any).name, 120) || categoryHint?.title || undefined;
  const categoryId = sanitizeString((rawCategory as any).id, 40) || categoryHint?.id || "";

  return {
    id: seed.id || undefined,
    title,
    bullets,
    description,
    aspects,
    category: {
      name: categoryName,
      id: categoryId || "",
    },
  };
}

function errorDraft(seed: Seed | null, message: string): Draft {
  return {
    id: seed?.id,
    title: "",
    bullets: [],
    description: `ERROR: ${message}`,
    aspects: seed?.brand ? { Brand: [seed.brand] } : {},
    category: {},
  };
}

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" }, originHdr, METHODS);
  }

  try {
    await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return jsonResponse(401, { ok: false, error: "Unauthorized" }, originHdr, METHODS);
  }

  const contentType = (headers["content-type"] || headers["Content-Type"] || "").toString();
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(415, { ok: false, error: "Use application/json" }, originHdr, METHODS);
  }

  let payload: any = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON" }, originHdr, METHODS);
  }

  const rawSeeds: any[] = Array.isArray(payload?.seeds) ? payload.seeds : [];
  if (!rawSeeds.length) {
    return jsonResponse(400, { ok: false, error: "Provide {seeds:[...]}" }, originHdr, METHODS);
  }

  const drafts: Draft[] = [];

  for (const raw of rawSeeds) {
    const seed = normalizeSeed(raw);
    if (!seed) {
      drafts.push(errorDraft(null, "invalid seed"));
      continue;
    }
    try {
      const categoryHint = await categoryHintForSeed(seed);
      const prompt = buildPrompt(seed, categoryHint);
      const rawResponse = await callOpenAI(prompt);
      let json: any = {};
      try {
        json = JSON.parse(rawResponse);
      } catch (err) {
        throw new Error(`Invalid JSON from OpenAI: ${(err as Error).message}`);
      }
      drafts.push(buildDraft(seed, json, categoryHint));
    } catch (err: any) {
      drafts.push(errorDraft(seed, err?.message || "generation failed"));
    }
  }

  console.log(
    JSON.stringify({ evt: "ai-gpt-drafts.done", count: drafts.length, ok: true })
  );

  return jsonResponse(200, { ok: true, count: drafts.length, drafts }, originHdr, METHODS);
};
