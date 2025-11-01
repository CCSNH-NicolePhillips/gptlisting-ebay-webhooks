import type { Handler } from "@netlify/functions";
import { createHash } from "node:crypto";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";
import { runAnalysis } from "../../src/lib/analyze-core.js";
import type { ImageInsight } from "../../src/lib/image-insight.js";
import { getTextEmb, getImageEmb } from "../../src/lib/clip-provider.js";
import { cosine, clipProviderInfo } from "../../src/lib/clip-client-split.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";
import { canConsumeImages, consumeImages } from "../../src/lib/quota.js";
import {
  getCachedSmartDraftGroups,
  makeCacheKey,
  setCachedSmartDraftGroups,
  type SmartDraftGroupCache,
} from "../../src/lib/smartdrafts-store.js";

type HeadersRecord = Record<string, string | undefined>;

type DropboxEntry = {
  ".tag": "file" | "folder";
  id: string;
  name: string;
  path_lower?: string | null;
  path_display?: string | null;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
  size?: number;
  media_info?: {
    metadata?: {
      dimensions?: {
        width?: number;
        height?: number;
      };
    };
  };
};

type OrphanImage = {
  url: string;
  name: string;
  folder: string;
};

type DebugComponent = {
  label: string;
  value: number;
  detail?: string;
};

type DebugCandidate = {
  url: string;
  name: string;
  path?: string;
  order: number;
  base: number;
  total: number;
  clipContribution: number;
  clipSimilarity?: number | null;
  passedThreshold: boolean;
  assigned?: boolean;
  components: DebugComponent[];
};

const METHODS = "POST, OPTIONS";
const MAX_IMAGES = Math.max(1, Math.min(100, Number(process.env.SMARTDRAFT_MAX_IMAGES || 100)));

function toUnit(v: number[]): number[] {
  let mag = 0;
  for (const x of v) mag += x * x;
  if (!mag) return v.map(() => 0);
  const inv = 1 / Math.sqrt(mag);
  return v.map((x) => x * inv);
}


function isImage(name: string) {
  return /\.(jpe?g|png|gif|webp|tiff?|bmp)$/i.test(name);
}

async function dropboxAccessToken(refreshToken: string, clientId?: string, clientSecret?: string) {
  const cid = clientId || process.env.DROPBOX_CLIENT_ID || "";
  const cs = clientSecret || process.env.DROPBOX_CLIENT_SECRET || "";
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cid,
    client_secret: cs,
  });
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.access_token) throw new Error(`dropbox token ${res.status}`);
  return String(json.access_token);
}

async function dropboxApi(token: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`dropbox ${res.status}`);
    return {};
  }
  try {
    const json = JSON.parse(text);
    if (!res.ok) throw new Error(`dropbox ${res.status}: ${text}`);
    return json;
  } catch {
    if (!res.ok) throw new Error(`dropbox ${res.status}: ${text}`);
    return {};
  }
}

async function listFolder(token: string, path: string): Promise<DropboxEntry[]> {
  let entries: DropboxEntry[] = [];
  let resp: any = await dropboxApi(token, "https://api.dropboxapi.com/2/files/list_folder", {
    include_deleted: false,
    include_media_info: true,
    recursive: true,
    path,
  });
  entries = entries.concat((resp?.entries as DropboxEntry[]) || []);
  while (resp?.has_more) {
    resp = await dropboxApi(token, "https://api.dropboxapi.com/2/files/list_folder/continue", {
      cursor: resp.cursor,
    });
    entries = entries.concat((resp?.entries as DropboxEntry[]) || []);
  }
  return entries.filter((entry) => entry[".tag"] === "file" && isImage(entry.name));
}

async function dbxSharedRawLink(access: string, filePath: string): Promise<string> {
  function normalize(u: string) {
    try {
      const url = new URL(u);
      if (/\.dropbox\.com$/i.test(url.hostname)) {
        url.hostname = "dl.dropboxusercontent.com";
      }
      url.searchParams.delete("dl");
      url.searchParams.set("raw", "1");
      return url.toString();
    } catch {
      return u
        .replace("www.dropbox.com", "dl.dropboxusercontent.com")
        .replace("?dl=0", "?raw=1")
        .replace("&dl=0", "&raw=1");
    }
  }

  const create = await fetch(
    "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    }
  );
  const cj: any = await create.json().catch(() => ({}));
  if (create.ok && cj?.url) return normalize(String(cj.url));
  const summary = cj?.error_summary || "";
  if (!create.ok && summary.includes("shared_link_already_exists")) {
    const r2 = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
      method: "POST",
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, direct_only: true }),
    });
    const j2: any = await r2.json().catch(() => ({}));
    if (!r2.ok || !j2.links?.length) throw new Error(`dbx links: ${r2.status} ${JSON.stringify(j2)}`);
    return normalize(String(j2.links[0].url));
  }
  throw new Error(`dbx share: ${create.status} ${JSON.stringify(cj)}`);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const current = next++;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = new Array(Math.min(limit, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return results;
}

function folderPath(entry: DropboxEntry) {
  const raw = entry.path_display || entry.path_lower || "";
  if (!raw) return "";
  const parts = raw.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function makeSignature(files: DropboxEntry[]): string {
  const joined = files
    .map((entry) => `${entry.id || entry.path_lower}:${entry.rev || ""}:${entry.server_modified || ""}:${entry.size || 0}`)
    .sort()
    .join("|");
  return createHash("sha1").update(joined).digest("hex");
}

function buildFallbackGroups(files: Array<{ entry: DropboxEntry; url: string }>) {
  const byFolder = new Map<string, Array<{ entry: DropboxEntry; url: string }>>();
  for (const item of files) {
    const key = folderPath(item.entry) || "(root)";
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key)!.push(item);
  }
  const groups: any[] = [];
  for (const [key, bucket] of byFolder.entries()) {
    const sorted = bucket.sort((a, b) => (a.entry.name || "").localeCompare(b.entry.name || ""));
    const images = sorted.map((item) => item.url).slice(0, 12);
    const name = key.split("/").filter(Boolean).pop() || key;
    groups.push({
      groupId: `fallback_${createHash("sha1").update(`${key}|${images[0] || ""}`).digest("hex").slice(0, 10)}`,
      name,
      folder: key === "(root)" ? "" : key,
      images,
      brand: undefined,
      product: name,
      variant: undefined,
      size: undefined,
      claims: [],
      confidence: 0.1,
      _fallback: true,
    });
  }
  return groups;
}

function hydrateOrphans(unused: Array<{ entry: DropboxEntry; url: string }>, folder: string): OrphanImage[] {
  return unused.map(({ entry, url }) => ({
    url,
    name: entry.name,
    folder: folderPath(entry) || folder,
  }));
}

function hydrateGroups(groups: any[], folder: string) {
  return groups.map((group) => {
    const titleParts = [group.brand, group.product].filter((part: string) => typeof part === "string" && part.trim());

    const displayName = titleParts.length ? titleParts.join(" — ") : group.name || group.product || "Product";
    return {
      ...group,
      name: displayName,
      folder,
      images: Array.isArray(group.images) ? group.images.slice(0, 12) : [],
      claims: Array.isArray(group.claims) ? group.claims.slice(0, 8) : [],
    };
  });
}

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersRecord;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" }, originHdr, METHODS);
  }

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return jsonResponse(401, { ok: false, error: "Unauthorized" }, originHdr, METHODS);
  }

  const ctype = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
  if (!ctype.includes("application/json")) {
    return jsonResponse(415, { ok: false, error: "Use application/json" }, originHdr, METHODS);
  }

  let body: any = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON" }, originHdr, METHODS);
  }

  const folder = typeof body?.path === "string" ? body.path.trim() : "";
  const force = Boolean(body?.force);
  const limitRaw = Number(body?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_IMAGES) : MAX_IMAGES;
  const debugRaw = body?.debug;
  const debugEnabled = typeof debugRaw === "string"
    ? ["1", "true", "yes", "debug"].includes(debugRaw.toLowerCase())
    : Boolean(debugRaw);

  if (!folder) {
    return jsonResponse(400, { ok: false, error: "Provide folder path" }, originHdr, METHODS);
  }

  try {
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(user.userId, "dropbox.json"), { type: "json" })) as any;
    const refresh = typeof saved?.refresh_token === "string" ? saved.refresh_token.trim() : "";
    if (!refresh) {
      return jsonResponse(400, { ok: false, error: "Connect Dropbox first" }, originHdr, METHODS);
    }

    const access = await dropboxAccessToken(refresh);
    const files = (await listFolder(access, folder)).sort((a, b) => (a.path_lower || "").localeCompare(b.path_lower || ""));
    if (!files.length) {
      return jsonResponse(200, {
        ok: true,
        folder,
        signature: null,
        count: 0,
        warnings: ["No images found in folder."],
        groups: [],
      }, originHdr, METHODS);
    }

    const limitedFiles = files.slice(0, limit);
    const signature = makeSignature(limitedFiles);
    const cacheKey = makeCacheKey(user.userId, folder);
    const cached = await getCachedSmartDraftGroups(cacheKey);
    if (!force && !debugEnabled && cached && cached.signature === signature && Array.isArray(cached.groups) && cached.groups.length) {
      return jsonResponse(200, {
        ok: true,
        cached: true,
        folder,
        signature,
        count: cached.groups.length,
        warnings: cached.warnings || [],
        groups: hydrateGroups(cached.groups, folder),
      }, originHdr, METHODS);
    }

    const fileTuples = await mapLimit(limitedFiles, 5, async (entry) => {
      const path = entry.path_lower || entry.path_display || entry.id;
      if (!path) throw new Error("Missing Dropbox path for image");
      const url = await dbxSharedRawLink(access, path);
      return { entry, url: toDirectDropbox(url) };
    });

    const tupleByUrl = new Map<string, { entry: DropboxEntry; url: string }>();
    const urlOrder = new Map<string, number>();
    fileTuples.forEach((tuple, idx) => {
      tupleByUrl.set(tuple.url, tuple);
      urlOrder.set(tuple.url, idx);
    });

    const urls = sanitizeUrls(fileTuples.map((tuple) => tuple.url));
    const analysisMeta = fileTuples.map((tuple) => ({
      url: tuple.url,
      name: tuple.entry?.name || "",
      folder: folderPath(tuple.entry) || folder,
    }));
    if (!urls.length) {
      const fallbackGroups = buildFallbackGroups(fileTuples);
      return jsonResponse(200, {
        ok: true,
        folder,
        signature,
        count: fallbackGroups.length,
        warnings: ["No usable image URLs; generated fallback groups."],
        groups: hydrateGroups(fallbackGroups, folder),
        orphans: hydrateOrphans(fileTuples, folder),
      }, originHdr, METHODS);
    }

    if (!debugEnabled) {
      const allowed = await canConsumeImages(user.userId, urls.length);
      if (!allowed) {
        return jsonResponse(429, { ok: false, error: "Daily image quota exceeded" }, originHdr, METHODS);
      }
      await consumeImages(user.userId, urls.length);
    }

    const analysis = await runAnalysis(urls, 12, { skipPricing: true, metadata: analysisMeta });
    const insightMap = new Map<string, ImageInsight>();
    const rawInsights = analysis?.imageInsights || {};
    Object.entries(rawInsights).forEach(([url, insight]) => {
      if (!url || !insight) return;
      const normalized = toDirectDropbox(url);
      insightMap.set(normalized, { ...insight, url: normalized });
    });
    let groups = Array.isArray(analysis?.groups) ? analysis.groups : [];
    let warnings: string[] = Array.isArray(analysis?.warnings) ? analysis.warnings : [];

    if (!groups.length) {
      const fallback = buildFallbackGroups(fileTuples);
      groups = fallback;
      warnings = [...warnings, "Vision grouping returned no results; falling back to folder grouping."];
    }

    const debugCandidatesPerGroup = debugEnabled ? groups.map(() => [] as DebugCandidate[]) : null;

    const desiredByGroup: string[][] = groups.map((group) => {
      const images = Array.isArray(group?.images) ? group.images : [];
      return images
        .map((img: unknown) => (typeof img === "string" ? toDirectDropbox(img) : ""))
        .filter((img: string) => img.length > 0);
    });

    const urlToGroups = new Map<string, number[]>();
    desiredByGroup.forEach((urls, gi) => {
      urls.forEach((url) => {
        const list = urlToGroups.get(url) || [];
        list.push(gi);
        urlToGroups.set(url, list);
      });
    });

    const tokenize = (value: string): string[] =>
      String(value || "")
        .toLowerCase()
        .replace(/[_\-.]+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(Boolean);

    const POS_NAME_TOKENS = new Set([
      "front",
      "hero",
      "main",
      "primary",
      "01",
      "1",
      "cover",
      "label",
      "face",
      "pack",
      "box",
      "bag",
    ]);

    const NEG_NAME_TOKENS = new Set([
      "back",
      "side",
      "barcode",
      "qrcode",
      "qr",
      "ingredients",
      "ingredient",
      "nutrition",
      "facts",
      "supplement",
      "panel",
      "blur",
      "blurry",
      "low",
      "res",
      "lowres",
      "placeholder",
      "dummy",
      "bw",
      "black",
      "white",
      "mono",
      "background",
      "_bg",
    ]);

  const CLIP_WEIGHT_RAW = Number(process.env.CLIP_WEIGHT ?? 20);
  const CLIP_WEIGHT = Number.isFinite(CLIP_WEIGHT_RAW) ? CLIP_WEIGHT_RAW : 20;
  const CLIP_MIN_SIM_RAW = Number(process.env.CLIP_MIN_SIM ?? 0.12);
  const CLIP_MIN_SIM = Number.isFinite(CLIP_MIN_SIM_RAW) ? CLIP_MIN_SIM_RAW : 0.12;
  const CLIP_MARGIN_RAW = Number(process.env.CLIP_MARGIN ?? 0.06);
  const CLIP_MARGIN = Number.isFinite(CLIP_MARGIN_RAW) ? CLIP_MARGIN_RAW : 0.06;
  const MIN_ASSIGN_RAW = Number(process.env.SMARTDRAFT_MIN_ASSIGN ?? 3);
  const MIN_ASSIGN = Number.isFinite(MIN_ASSIGN_RAW) ? MIN_ASSIGN_RAW : 3;
  const MAX_DUPES_RAW = Number(process.env.SMARTDRAFT_MAX_DUPES ?? 1);
  const MAX_DUPES_PER_GROUP = Number.isFinite(MAX_DUPES_RAW) ? MAX_DUPES_RAW : 1;
  const BRAND_SEP_ALPHA_RAW = Number(process.env.BRAND_SEP_ALPHA ?? 0.25);
  const BRAND_SEP_ALPHA = Number.isFinite(BRAND_SEP_ALPHA_RAW) ? BRAND_SEP_ALPHA_RAW : 0.25;

    const COLOR_WEIGHTS: Record<string, number> = {
      black: -8,
      white: -6,
      gray: -5,
      brown: -1,
      red: 3,
      orange: 3,
      yellow: 3,
      green: 3,
      blue: 3,
      purple: 2,
      multi: 2,
    };

    const ROLE_WEIGHTS: Record<string, number> = {
      front: 12,
      packaging: 8,
      side: 4,
      detail: -1,
      accessory: -4,
      back: -8,
      other: 0,
    };

    const groupTokens: string[][] = groups.map((group) => {
      const parts: string[] = [];
      if (group?.brand) parts.push(String(group.brand));
      if (group?.product) parts.push(String(group.product));
      if (group?.variant) parts.push(String(group.variant));
      if (Array.isArray(group?.claims)) parts.push(...group.claims.slice(0, 8).map(String));
      return tokenize(parts.join(" "));
    });

    const allGroups = groups.map((group, gi) => {
      const groupId =
        typeof group?.groupId === "string" && group.groupId ? String(group.groupId) : `group_${gi + 1}`;
      const brand = typeof group?.brand === "string" ? group.brand.trim() : "";
      return { group, index: gi, groupId, brand };
    });

    const groupTextVecs = new Map<string, number[] | null>();
    let firstTextDim = 0;
    let firstImageDim = 0;
    let lastClipError: string | null = null;

    const brandEmbeddingCache = new Map<string, Promise<number[] | null>>();
    const getBrandEmbedding = (brand: string): Promise<number[] | null> => {
      const key = brand.trim().toLowerCase();
      if (!key) return Promise.resolve(null);
      if (!brandEmbeddingCache.has(key)) {
        brandEmbeddingCache.set(
          key,
          getTextEmb(brand).catch((err: any) => {
            if (!lastClipError) {
              lastClipError = err?.message ? String(err.message) : String(err ?? "brand text embedding failed");
            }
            return null;
          })
        );
      }
      return brandEmbeddingCache.get(key)!;
    };

    for (const { group, groupId } of allGroups) {
      const seedParts = [group?.brand, group?.product, group?.variant, group?.size, "bottle packaging photo"]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean);
      const seedText = seedParts.join(" ") || "product bottle packaging photo";

      try {
        let seedVec = await getTextEmb(seedText);
        if (seedVec && !firstTextDim) firstTextDim = seedVec.length;

        if (seedVec) {
          const otherBrands = allGroups
            .filter((entry) => entry.groupId !== groupId)
            .map((entry) => entry.brand)
            .filter((value) => Boolean(value));

          if (otherBrands.length) {
            const otherVecsRaw = await Promise.all(otherBrands.map((brand) => getBrandEmbedding(brand)));
            const otherVecs = otherVecsRaw.filter((vec): vec is number[] => Array.isArray(vec) && vec.length > 0);
            if (otherVecs.length && seedVec.length === otherVecs[0].length) {
              const meanOther = toUnit(
                otherVecs[0].map((_, idx) => otherVecs.reduce((sum, vec) => sum + vec[idx], 0) / otherVecs.length)
              );
              if (meanOther.length === seedVec.length) {
                seedVec = toUnit(seedVec.map((value, idx) => value - BRAND_SEP_ALPHA * meanOther[idx]));
              }
            }
          }
        }

        groupTextVecs.set(groupId, seedVec);
      } catch (err: any) {
        if (!lastClipError) {
          lastClipError = err?.message ? String(err.message) : String(err ?? "text embedding failed");
        }
        groupTextVecs.set(groupId, null);
      }
    }

    const clipEnabled =
      CLIP_WEIGHT > 0 && [...groupTextVecs.values()].some((emb) => Array.isArray(emb) && emb.length > 0);

    const imageEmbeddingCache = new Map<string, Promise<number[] | null>>();

    const getImageEmbedding = (url: string): Promise<number[] | null> => {
      const normalized = toDirectDropbox(url);
      if (!imageEmbeddingCache.has(normalized)) {
        const promise = getImageEmb(normalized)
          .then((vector) => {
            if (vector && !firstImageDim) firstImageDim = vector.length;
            return vector;
          })
          .catch((err: any) => {
            if (!lastClipError) {
              lastClipError = err?.message ? String(err.message) : String(err ?? "image embedding failed");
            }
            return null;
          });
        imageEmbeddingCache.set(normalized, promise);
      }
      return imageEmbeddingCache.get(normalized)!;
    };

    const looksDummyByMeta = (entry: DropboxEntry): boolean => {
      const size = Number(entry?.size || 0);
      if (size > 0 && size < 10 * 1024) return true;
      const dims = entry?.media_info?.metadata?.dimensions;
      const width = Number(dims?.width || 0);
      const height = Number(dims?.height || 0);
      if (width && height && (width < 200 || height < 200)) return true;
      return false;
    };

    const scoreImageForGroup = (
      tuple: { entry: DropboxEntry; url: string },
      gi: number,
      captureDetails = false
    ): { score: number; components?: DebugComponent[] } => {
      const insight = insightMap.get(tuple.url);
      let score = 0;
      const components = captureDetails ? ([] as DebugComponent[]) : undefined;
      const add = (label: string, value: number, detail?: string) => {
        score += value;
        if (components && value !== 0) components.push({ label, value, detail });
      };

      const path = String(tuple.entry?.path_display || tuple.entry?.path_lower || "");
      const base = String(tuple.entry?.name || "");
      const nameTokens = new Set(tokenize(base));
      const allTokens = new Set<string>([...tokenize(path), ...nameTokens]);

      for (const token of groupTokens[gi] || []) {
        if (allTokens.has(token)) add("token-match", 3, token);
      }

      for (const token of nameTokens) {
        if (POS_NAME_TOKENS.has(token)) add("name-positive", 12, token);
        if (NEG_NAME_TOKENS.has(token)) add("name-negative", -10, token);
      }

      if (insight?.hasVisibleText === true) add("visible-text", 6);
      else if (insight?.hasVisibleText === false) add("no-visible-text", -5);

      if (insight?.role && ROLE_WEIGHTS[insight.role] !== undefined) {
        add("role", ROLE_WEIGHTS[insight.role], insight.role);
      }

      if (insight?.dominantColor && COLOR_WEIGHTS[insight.dominantColor] !== undefined) {
        add("color", COLOR_WEIGHTS[insight.dominantColor], insight.dominantColor);
      }

      if ((desiredByGroup[gi] || []).includes(tuple.url)) add("vision-suggested", 10);

      const confidence = Number(groups[gi]?.confidence || 0);
      const confBoost = Math.min(5, Math.max(0, Math.round(confidence)));
      if (confBoost) add("group-confidence", confBoost, String(confidence));

      if (looksDummyByMeta(tuple.entry)) add("metadata-dummy", -8);

      const dims = tuple.entry?.media_info?.metadata?.dimensions;
      const width = Number(dims?.width || 0);
      const height = Number(dims?.height || 0);
      if (width > 0 && height > 0) {
        const megaPixels = (width * height) / 1_000_000;
        if (megaPixels >= 3.5) add("resolution", 8, `mp:${megaPixels.toFixed(2)}`);
        else if (megaPixels >= 2) add("resolution", 6, `mp:${megaPixels.toFixed(2)}`);
        else if (megaPixels >= 1) add("resolution", 4, `mp:${megaPixels.toFixed(2)}`);
        else if (megaPixels >= 0.6) add("resolution", 1, `mp:${megaPixels.toFixed(2)}`);
        else add("resolution", -6, `mp:${megaPixels.toFixed(2)}`);

        const aspect = width / height;
        if (aspect > 0) {
          if (aspect >= 0.8 && aspect <= 1.25) add("aspect", 3, `ratio:${aspect.toFixed(2)}`);
          else if (aspect >= 0.6 && aspect <= 1.45) add("aspect", 1, `ratio:${aspect.toFixed(2)}`);
          else if (aspect <= 0.45 || aspect >= 1.8) add("aspect", -4, `ratio:${aspect.toFixed(2)}`);
        }
      }

      if (components) {
        return { score, components };
      }
      return { score };
    };

    const imageEmbeddings = await Promise.all(
      fileTuples.map((tuple) => (clipEnabled ? getImageEmbedding(tuple.url) : Promise.resolve(null)))
    );

    if (!firstImageDim && fileTuples.length) {
      try {
        const probe = await getImageEmbedding(fileTuples[0].url);
        if (probe && !firstImageDim) firstImageDim = probe.length;
      } catch (err: any) {
        if (!lastClipError) {
          lastClipError = err?.message ? String(err.message) : String(err ?? "image embedding probe failed");
        }
      }
    }

    type Rank = { groupId: string; sim: number };
    const ranksByImage = new Map<string, Rank[]>();

    for (let ti = 0; ti < fileTuples.length; ti++) {
      const tuple = fileTuples[ti];
      for (let gi = 0; gi < groups.length; gi++) {
        const baseResult = scoreImageForGroup(tuple, gi, debugEnabled);
        const base = baseResult.score;
        if (!Number.isFinite(base)) continue;

        let combined = base;
        let clipContribution = 0;
        let clipSimilarity: number | null = null;
    const groupId = allGroups[gi].groupId;
        if (clipEnabled) {
          const textEmb = groupTextVecs.get(groupId);
          const imageEmb = imageEmbeddings[ti];
          if (textEmb && imageEmb && textEmb.length === imageEmb.length) {
            const similarity = cosine(textEmb, imageEmb);
            if (Number.isFinite(similarity)) {
              clipSimilarity = similarity;
              if (similarity >= CLIP_MIN_SIM) {
                clipContribution = Math.round(similarity * CLIP_WEIGHT);
                combined += clipContribution;
                const ranks = ranksByImage.get(tuple.url) || [];
                ranks.push({ groupId, sim: similarity });
                ranksByImage.set(tuple.url, ranks);
              }
            }
          }
        }

        if (debugCandidatesPerGroup) {
          const components = baseResult.components ? [...baseResult.components] : [];
          if (clipSimilarity !== null || clipContribution !== 0) {
            components.push({
              label: "clip",
              value: clipContribution,
              detail: clipSimilarity === null ? undefined : clipSimilarity.toFixed(3),
            });
          }
          debugCandidatesPerGroup[gi].push({
            url: tuple.url,
            name: tuple.entry?.name || "",
            path: tuple.entry?.path_display || tuple.entry?.path_lower || "",
            order: urlOrder.has(tuple.url) ? urlOrder.get(tuple.url)! : Number.MAX_SAFE_INTEGER,
            base,
            total: combined,
            clipContribution,
            clipSimilarity,
            passedThreshold: combined >= MIN_ASSIGN,
            components,
          });
        }
      }
    }
    fileTuples.forEach((tuple) => {
      if (!ranksByImage.has(tuple.url)) ranksByImage.set(tuple.url, []);
    });
    for (const ranks of ranksByImage.values()) {
      ranks.sort((a, b) => b.sim - a.sim);
    }

    const assignedByGroup = new Map<string, Set<string>>();
    const assignedImageTo = new Map<string, string>();
    const dupesUsed = new Map<string, number>();

    const ensureGroupSet = (groupId: string): Set<string> => {
      let set = assignedByGroup.get(groupId);
      if (!set) {
        set = new Set<string>();
        assignedByGroup.set(groupId, set);
      }
      return set;
    };

    const addToGroup = (groupId: string, imageUrl: string): boolean => {
      const set = ensureGroupSet(groupId);
      const before = set.size;
      set.add(imageUrl);
      assignedImageTo.set(imageUrl, groupId);
      return set.size !== before;
    };

    const canUseDuplicate = (groupId: string) => {
      const used = dupesUsed.get(groupId) ?? 0;
      return used < MAX_DUPES_PER_GROUP;
    };

    // Pass A: decisive winners claim their images outright.
    for (const [imageUrl, ranks] of ranksByImage.entries()) {
      if (!ranks.length) continue;
      const best = ranks[0];
      const next = ranks[1];
      const decisive = !next || best.sim - next.sim >= CLIP_MARGIN;
      if (!decisive) continue;
      if (!assignedImageTo.has(imageUrl)) {
        addToGroup(best.groupId, imageUrl);
      }
    }

    // Pass B: satisfy minimum coverage, allowing limited duplicates when required.
    for (const { groupId } of allGroups) {
      const set = ensureGroupSet(groupId);
      const minTarget = Math.max(0, Math.round(MIN_ASSIGN));
      let remaining = Math.max(0, minTarget - set.size);
      if (!remaining) continue;

      for (const [imageUrl, ranks] of ranksByImage.entries()) {
        if (remaining <= 0) break;
        const rank = ranks.find((entry) => entry.groupId === groupId);
        if (!rank || rank.sim < CLIP_MIN_SIM) continue;

        const existing = assignedImageTo.get(imageUrl);
        if (!existing) {
          if (addToGroup(groupId, imageUrl)) remaining--;
          continue;
        }

        if (existing === groupId) continue;
        if (!canUseDuplicate(groupId)) continue;
        const beforeCount = set.size;
        set.add(imageUrl);
        if (set.size !== beforeCount) {
          dupesUsed.set(groupId, (dupesUsed.get(groupId) ?? 0) + 1);
          remaining--;
        }
      }
    }

    // Pass C: resolve conflicts by similarity and scarcity.
    for (const [imageUrl, ranks] of ranksByImage.entries()) {
      const holders = allGroups.filter((entry) => ensureGroupSet(entry.groupId).has(imageUrl));
      if (holders.length <= 1) {
        if (holders.length === 1) assignedImageTo.set(imageUrl, holders[0].groupId);
        continue;
      }

      holders.sort((g1, g2) => {
        const s1 = ranks.find((r) => r.groupId === g1.groupId)?.sim ?? 0;
        const s2 = ranks.find((r) => r.groupId === g2.groupId)?.sim ?? 0;
        if (Math.abs(s2 - s1) > 1e-6) return s2 - s1;
        const c1 = ensureGroupSet(g1.groupId).size;
        const c2 = ensureGroupSet(g2.groupId).size;
        return c1 - c2;
      });

      const keeper = holders[0].groupId;
      assignedImageTo.set(imageUrl, keeper);
      for (let i = 1; i < holders.length; i++) {
        ensureGroupSet(holders[i].groupId).delete(imageUrl);
      }
    }

    // Ensure every retained image has a recorded owner post-resolution.
    for (const { groupId } of allGroups) {
      const set = assignedByGroup.get(groupId);
      if (!set) continue;
      for (const imageUrl of set) {
        if (!assignedImageTo.has(imageUrl)) assignedImageTo.set(imageUrl, groupId);
      }
    }

    const assignedLists = groups.map((_, gi) => {
      const groupId = allGroups[gi].groupId;
      return Array.from(assignedByGroup.get(groupId) ?? []);
    });

    if (debugCandidatesPerGroup) {
      for (let gi = 0; gi < groups.length; gi++) {
        const assignedSet = new Set(assignedLists[gi]);
        debugCandidatesPerGroup[gi] = debugCandidatesPerGroup[gi]
          .map((entry) => ({ ...entry, assigned: assignedSet.has(entry.url) }))
          .sort((a, b) => b.total - a.total);
      }
    }

    const usedUrls = new Set<string>();
    assignedLists.forEach((urls) => urls.forEach((url) => usedUrls.add(url)));

    let reassignedCount = 0;
    fileTuples.forEach((tuple) => {
      const candidates = urlToGroups.get(tuple.url) || [];
      if (candidates.length > 1) reassignedCount++;
    });

    const normalizedGroups: any[] = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const seen = new Set<string>();
      let unique = assignedLists[gi].filter((url) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });

      if (!unique.length) {
        const label = group?.name || group?.product || `group_${gi + 1}`;
        warnings.push(`No text-bearing hero found for ${label}; leaving group images empty.`);
      }

      unique = unique
        .map((url, idx) => ({ url, idx }))
        .sort((a, b) => {
          const entryA = tupleByUrl.get(a.url);
          const entryB = tupleByUrl.get(b.url);
          const tokensA = tokenize(entryA?.entry?.name || a.url);
          const tokensB = tokenize(entryB?.entry?.name || b.url);
          let biasA = tokensA.some((token) => POS_NAME_TOKENS.has(token)) ? -1 : 0;
          let biasB = tokensB.some((token) => POS_NAME_TOKENS.has(token)) ? -1 : 0;
          const insightA = insightMap.get(a.url);
          const insightB = insightMap.get(b.url);
          if (insightA?.role === "front") biasA -= 2;
          if (insightB?.role === "front") biasB -= 2;
          if (insightA?.role === "back") biasA += 2;
          if (insightB?.role === "back") biasB += 2;
          if (biasA !== biasB) return biasA - biasB;
          const orderA = urlOrder.has(a.url) ? urlOrder.get(a.url)! : Number.MAX_SAFE_INTEGER + a.idx;
          const orderB = urlOrder.has(b.url) ? urlOrder.get(b.url)! : Number.MAX_SAFE_INTEGER + b.idx;
          return orderA - orderB;
        })
  .map((item) => item.url)
    .slice(0, 12);

      normalizedGroups.push({ ...group, images: unique });
    }

    const orphanTuples = fileTuples.filter((tuple) => !usedUrls.has(tuple.url));
    if (reassignedCount > 0) {
      warnings = [...warnings, `Rebalanced duplicate image references across groups (${reassignedCount} adjusted).`];
    }
    const orphans = hydrateOrphans(orphanTuples, folder);

    const payloadGroups = hydrateGroups(normalizedGroups, folder);

    const cachePayload: SmartDraftGroupCache = {
      signature,
      groups: payloadGroups,
      orphans,
      warnings,
      updatedAt: Date.now(),
    };
    await setCachedSmartDraftGroups(cacheKey, cachePayload);

    const responsePayload: any = {
      ok: true,
      folder,
      signature,
      count: payloadGroups.length,
      warnings,
      groups: payloadGroups,
      orphans,
    };

    if (debugCandidatesPerGroup) {
      const debugGroups = debugCandidatesPerGroup.map((entries, gi) => {
        const group = groups[gi];
        const displayName =
          (typeof group?.name === "string" && group.name) ||
          (typeof group?.product === "string" && group.product) ||
          `group_${gi + 1}`;
        return {
          groupId: group?.groupId || `group_${gi + 1}`,
          name: displayName,
          candidates: entries.slice(0, 20),
        };
      });

      const providerMeta = clipProviderInfo();
      const clipDebug: Record<string, unknown> = {
        ...providerMeta,
        weight: CLIP_WEIGHT,
        minSimilarity: CLIP_MIN_SIM,
        textDim: firstTextDim,
        imgDim: firstImageDim,
        enabled: Boolean(firstTextDim && firstImageDim),
      };
      const fallbackClipError =
        lastClipError ||
        (!process.env.HF_API_TOKEN
          ? "HF_API_TOKEN missing"
          : !firstTextDim
          ? "Text embedding unavailable"
          : !firstImageDim
          ? "Image embedding unavailable"
          : undefined);
      if (fallbackClipError) clipDebug.error = fallbackClipError;

      const totalAssigned = [...assignedByGroup.values()].reduce((sum, set) => sum + set.size, 0);
      const uniqueOwners = new Set(assignedImageTo.values());
      const duplicateCount = Math.max(0, totalAssigned - uniqueOwners.size);
      const duplicateGroupsList = [...dupesUsed.entries()]
        .filter(([, count]) => (count ?? 0) > 0)
        .map(([groupId]) => groupId);
      const duplicatesDebug = duplicateCount > 0 || duplicateGroupsList.length > 0
        ? { count: duplicateCount, groups: duplicateGroupsList, margin: CLIP_MARGIN }
        : undefined;

      responsePayload.debug = {
        minAssign: MIN_ASSIGN,
        clip: clipDebug,
        groups: debugGroups,
        ...(duplicatesDebug ? { duplicates: duplicatesDebug } : {}),
      };
    }

    return jsonResponse(200, responsePayload, originHdr, METHODS);
  } catch (err: any) {
    return jsonResponse(500, { ok: false, error: err?.message || String(err) }, originHdr, METHODS);
  }
};
