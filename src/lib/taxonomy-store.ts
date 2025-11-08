import type { CategoryDef } from "./taxonomy-schema.js";

const RAW_BASE = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!RAW_BASE || !TOKEN) {
  console.warn("⚠️ Upstash Redis env vars missing – taxonomy registry unavailable.");
}

type Arg = string | number | boolean | null | undefined;

function ensureConfigured(): string {
  if (!RAW_BASE || !TOKEN) {
    throw new Error("Upstash Redis not configured for taxonomy registry");
  }
  return RAW_BASE;
}

function encodeArg(arg: Arg): string {
  const value = arg == null ? "" : String(arg);
  return encodeURIComponent(value);
}

async function call(command: string, args: Arg[] = []): Promise<any> {
  const base = ensureConfigured();
  const path = [command.toLowerCase(), ...args.map(encodeArg)].join("/");
  const url = `${base}/${path}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Upstash ${res.status}: ${detail}`);
  }

  const data = await res.json().catch(() => null);
  return data?.result ?? null;
}

export async function putCategory(cat: CategoryDef): Promise<void> {
  await call("sadd", ["taxonomy:index", cat.slug]);
  await call("set", [`taxonomy:cat:${cat.slug}`, JSON.stringify(cat)]);
  // Also store by ID for fast lookups
  await call("set", [`taxonomy:id:${cat.id}`, JSON.stringify(cat)]);
}

export async function getCategory(slug: string): Promise<CategoryDef | null> {
  if (!slug) return null;
  const raw = await call("get", [`taxonomy:cat:${slug}`]);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CategoryDef;
  } catch {
    return null;
  }
}

export async function getCategoryById(categoryId: string): Promise<CategoryDef | null> {
  if (!categoryId) return null;
  
  // Try to get by ID directly (stored in index)
  const raw = await call("get", [`taxonomy:id:${categoryId}`]);
  if (raw) {
    try {
      return JSON.parse(raw) as CategoryDef;
    } catch {
      // Fall through to search
    }
  }
  
  // Fallback: search through all categories
  const categories = await listCategories();
  return categories.find((cat) => cat.id === categoryId) || null;
}

export async function listCategories(): Promise<CategoryDef[]> {
  const indexResult = await call("smembers", ["taxonomy:index"]);
  const members = Array.isArray(indexResult) ? indexResult : [];
  const slugs: string[] = members
    .map((entry) => (typeof entry === "string" ? entry : String(entry)))
    .filter(Boolean);

  if (!slugs.length) return [];

  const categories: CategoryDef[] = [];
  await Promise.all(
    slugs.map(async (slug) => {
      const raw = await call("get", [`taxonomy:cat:${slug}`]);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as CategoryDef;
        if (parsed && parsed.slug === slug) {
          categories.push(parsed);
        }
      } catch {
        /* ignore malformed */
      }
    }),
  );

  return categories.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
