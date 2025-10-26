import type { CategoryDef } from "./taxonomy-schema.js";

const RAW_BASE = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!RAW_BASE || !TOKEN) {
  console.warn("⚠️ Upstash Redis env vars missing – taxonomy registry unavailable.");
}
const PIPELINE_URL = RAW_BASE ? `${RAW_BASE}/pipeline` : undefined;

type CommandSpec = {
  command: string;
  args?: Array<string | number | boolean | null | undefined>;
};

type PipelineSpec = {
  pipeline: CommandSpec[];
};

type SingleCommandSpec = {
  command: string;
  args?: Array<string | number | boolean | null | undefined>;
};

type UpstashPayload = PipelineSpec | SingleCommandSpec;

type PipelineResponse = any[];

function ensureConfigured(): string {
  if (!PIPELINE_URL || !TOKEN) {
    throw new Error("Upstash Redis not configured for taxonomy registry");
  }
  return PIPELINE_URL;
}

function toCommandArray(spec: CommandSpec): string[] {
  const args = Array.isArray(spec.args) ? spec.args : [];
  return [spec.command, ...args.map((arg) => (arg == null ? "" : String(arg)))];
}

async function upstash(body: UpstashPayload): Promise<PipelineResponse> {
  const pipelineUrl = ensureConfigured();
  const commands = "pipeline" in body ? body.pipeline : [body];
  const payload = { commands: commands.map(toCommandArray) };

  const res = await fetch(pipelineUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Upstash ${res.status}: ${detail}`);
  }

  const json = (await res.json().catch(() => null)) as PipelineResponse | null;
  if (!json || !Array.isArray(json)) {
    throw new Error("Unexpected Upstash response format");
  }

  return json;
}

async function runCommand(command: string, args: CommandSpec["args"] = []): Promise<any> {
  const [result] = await upstash({ command, args });
  return result;
}

export async function putCategory(cat: CategoryDef): Promise<void> {
  await upstash({
    pipeline: [
      { command: "SADD", args: ["taxonomy:index", cat.slug] },
      { command: "SET", args: [`taxonomy:cat:${cat.slug}`, JSON.stringify(cat)] },
    ],
  });
}

export async function getCategory(slug: string): Promise<CategoryDef | null> {
  if (!slug) return null;
  const result = await runCommand("GET", [`taxonomy:cat:${slug}`]);
  const raw = typeof result === "string" ? result : result?.result ?? null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CategoryDef;
  } catch {
    return null;
  }
}

export async function listCategories(): Promise<CategoryDef[]> {
  const indexResult = await runCommand("SMEMBERS", ["taxonomy:index"]);
  const slugs: string[] = Array.isArray(indexResult)
    ? indexResult.map((entry) => (typeof entry === "string" ? entry : String(entry))).filter(Boolean)
    : [];

  if (!slugs.length) return [];

  const pipeline = slugs.map((slug) => ({ command: "GET", args: [`taxonomy:cat:${slug}`] }));
  const responses = await upstash({ pipeline });

  const categories: CategoryDef[] = [];
  responses.forEach((entry, idx) => {
    const raw = typeof entry === "string" ? entry : entry?.result ?? null;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as CategoryDef;
      if (parsed && parsed.slug === slugs[idx]) {
        categories.push(parsed);
      }
    } catch {
      /* ignore malformed */
    }
  });

  return categories.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
