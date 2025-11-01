import type { Handler } from "@netlify/functions";
import { createHash } from "node:crypto";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";
import { runAnalysis } from "../../src/lib/analyze-core.js";
import type { ImageInsight } from "../../src/lib/image-insight.js";
import { clipImageEmbedding, cosine, clipProviderInfo } from "../../src/lib/clip-client-split.js";
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
  margin?: number | null;
  components: DebugComponent[];
};

type AnalyzedGroup = {
  groupId?: string;
  images?: string[];
  heroUrl?: string;
  backUrl?: string;
  primaryImageUrl?: string;
  secondaryImageUrl?: string;
  supportingImageUrls?: string[];
  [key: string]: unknown;
};

type CandidateDetail = {
  url: string;
  name: string;
  folder: string;
  order: number;
  ocrText: string;
  _role?: "front" | "back";
  _hasText?: boolean;
};

const METHODS = "POST, OPTIONS";
const MAX_IMAGES = Math.max(1, Math.min(100, Number(process.env.SMARTDRAFT_MAX_IMAGES || 100)));

const normalizeFolderKey = (value: string | null | undefined): string => {
  if (!value) return "";
  return value.replace(/^[\\/]+/, "").trim();
};

function basenameFrom(u: string): string {
  try {
    if (!u) return "";
    const trimmed = u.trim();
    if (!trimmed) return "";
    const noQuery = trimmed.split("?")[0];
    const parts = noQuery.split("/");
    return parts[parts.length - 1] || "";
  } catch {
    return u;
  }
}

type RoleInfo = { role?: "front" | "back"; hasVisibleText?: boolean; ocr?: string };

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

    const cachedLinks = cached?.links && typeof cached.links === "object" ? cached.links : undefined;
    const linkLookup = new Map<string, string>();
    const linkPersist = new Map<string, string>();
    if (cachedLinks) {
      for (const [key, value] of Object.entries(cachedLinks)) {
        if (typeof key === "string" && typeof value === "string" && key && value) {
          try {
            const direct = toDirectDropbox(value);
            linkLookup.set(key, direct);
            linkPersist.set(key, direct);
          } catch {
            // ignore malformed cached link
          }
        }
      }
    }

    const missingEntries: Array<{ entry: DropboxEntry; key: string }> = [];

    const resolveKey = (entry: DropboxEntry): string => entry.id || entry.path_lower || entry.path_display || entry.name || "";

    for (const entry of limitedFiles) {
      const key = resolveKey(entry);
      if (!key) {
        missingEntries.push({ entry, key: entry.id || entry.path_lower || entry.path_display || entry.name || "" });
        continue;
      }
      if (linkLookup.has(key)) {
        const cachedUrl = linkLookup.get(key)!;
        if (entry.id) {
          linkPersist.set(entry.id, cachedUrl);
        } else if (key) {
          linkPersist.set(key, cachedUrl);
        }
        continue;
      }
      missingEntries.push({ entry, key });
    }

    const fetchedTuples = await mapLimit(missingEntries, 5, async ({ entry, key }) => {
      if (key && linkLookup.has(key)) {
        const cachedUrl = linkLookup.get(key)!;
        if (entry.id) {
          linkPersist.set(entry.id, cachedUrl);
        } else if (key) {
          linkPersist.set(key, cachedUrl);
        }
        return { entry, url: cachedUrl };
      }
      const path = entry.path_lower || entry.path_display || entry.id;
      if (!path) throw new Error("Missing Dropbox path for image");
      const url = await dbxSharedRawLink(access, path);
      const direct = toDirectDropbox(url);
      if (key) linkLookup.set(key, direct);
      if (entry.id) {
        linkLookup.set(entry.id, direct);
        linkPersist.set(entry.id, direct);
      } else if (key) {
        linkPersist.set(key, direct);
      }
      if (entry.path_lower && entry.path_lower !== key) linkLookup.set(entry.path_lower, direct);
      if (entry.path_display && entry.path_display !== key) linkLookup.set(entry.path_display, direct);
      return { entry, url: direct };
    });

    const fetchedByKey = new Map<string, string>();
    fetchedTuples.forEach(({ entry, url }) => {
      const key = resolveKey(entry);
      if (key && !linkLookup.has(key)) linkLookup.set(key, url);
      fetchedByKey.set(key, url);
    });

    const fileTuples = limitedFiles.map((entry) => {
      const key = resolveKey(entry);
      let url = (key && linkLookup.get(key)) || null;
      if (!url && entry.id) url = linkLookup.get(entry.id) || null;
      if (!url && entry.path_lower) url = linkLookup.get(entry.path_lower) || null;
      if (!url && entry.path_display) url = linkLookup.get(entry.path_display) || null;
      if (!url) {
        const fallback =
          fetchedByKey.get(key) || fetchedByKey.get(entry.id || "") || fetchedByKey.get(entry.path_lower || "");
        if (fallback) {
          url = fallback;
        }
      }
      if (!url) throw new Error(`Unable to resolve Dropbox share link for ${entry.name || entry.id || "image"}`);
      if (entry.id) {
        linkPersist.set(entry.id, url);
      } else if (key) {
        linkPersist.set(key, url);
      }
      return { entry, url };
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

    const analysis = await runAnalysis(urls, 12, {
      skipPricing: true,
      metadata: analysisMeta,
      debugVisionResponse: debugEnabled,
    });
  const insightMap = new Map<string, ImageInsight>();
  const insightByBase = new Map<string, ImageInsight>();
  const roleByBase = new Map<string, RoleInfo>();
    const rawInsights = analysis?.imageInsights || {};
    const insightList: ImageInsight[] = Array.isArray(rawInsights)
      ? (rawInsights as ImageInsight[])
      : Object.entries(rawInsights)
          .map(([url, insight]) => {
            if (!insight) return null;
            return { ...(insight as ImageInsight), url };
          })
          .filter((value): value is ImageInsight => Boolean(value));

    const extractInsightOcr = (insight: ImageInsight | undefined): string => {
      if (!insight) return "";
      const data = insight as any;
      const parts: string[] = [];
      const push = (value: unknown) => {
        if (typeof value === "string" && value.trim()) parts.push(value.trim());
      };
      push(data?.ocrText);
      if (Array.isArray(data?.textBlocks)) push(data.textBlocks.join(" "));
      push(data?.text);
      if (typeof data?.ocr?.text === "string") push(data.ocr.text);
      if (Array.isArray(data?.ocr?.lines)) push(data.ocr.lines.join(" "));
      return parts.join(" ").trim();
    };

    insightList.forEach((insight) => {
      const normalizedUrl = typeof insight.url === "string" ? toDirectDropbox(insight.url) : "";
      if (!normalizedUrl) return;
      const payload: ImageInsight = { ...insight, url: normalizedUrl };
      insightMap.set(normalizedUrl, payload);
      const base = basenameFrom(normalizedUrl).toLowerCase();
      if (base) {
        if (!insightByBase.has(base)) {
          insightByBase.set(base, payload);
        }
        const roleRaw = typeof payload.role === "string" ? payload.role.toLowerCase().trim() : "";
        const info: RoleInfo = {};
        if (roleRaw === "front" || roleRaw === "back") {
          info.role = roleRaw;
        }
        if (typeof payload.hasVisibleText === "boolean") {
          info.hasVisibleText = payload.hasVisibleText;
        }
        const ocrText = extractInsightOcr(payload);
        if (ocrText) info.ocr = ocrText;
        if (info.role || info.hasVisibleText !== undefined || info.ocr) {
          roleByBase.set(base, info);
        }
      }
    });

    for (const tuple of fileTuples) {
      const bases = [basenameFrom(tuple.url), basenameFrom(tuple.entry?.name || "")]
        .map((value) => value.toLowerCase())
        .filter(Boolean);
      for (const base of bases) {
        const match = insightByBase.get(base);
        if (match) {
          insightMap.set(tuple.url, match);
          if (!roleByBase.has(base)) {
            const roleRaw = typeof match.role === "string" ? match.role.toLowerCase().trim() : "";
            const info: RoleInfo = {};
            if (roleRaw === "front" || roleRaw === "back") info.role = roleRaw;
            if (typeof match.hasVisibleText === "boolean") info.hasVisibleText = match.hasVisibleText;
            const ocrText = extractInsightOcr(match);
            if (ocrText) info.ocr = ocrText;
            if (info.role || info.hasVisibleText !== undefined || info.ocr) roleByBase.set(base, info);
          }
          break;
        }
      }
    }

    const roleInfoFor = (value: string | null | undefined): RoleInfo | undefined => {
      if (!value) return undefined;
      const base = basenameFrom(value).toLowerCase();
      if (!base) return undefined;
      return roleByBase.get(base);
    };

    const insightForUrl = (value: string | null | undefined): ImageInsight | undefined => {
      if (!value) return undefined;
      const normalized = toDirectDropbox(value);
      return insightMap.get(normalized) || insightMap.get(value) || insightByBase.get(basenameFrom(value).toLowerCase());
    };
    let groups = Array.isArray(analysis?.groups)
      ? (analysis.groups as AnalyzedGroup[])
      : [];
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

  const STRICT_TWO_IF_SMALL = (process.env.STRICT_TWO_IF_SMALL ?? "true").toLowerCase() === "true";
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
  const HERO_LOCK = true;
  const HERO_WEIGHT_RAW = Number(process.env.HERO_WEIGHT ?? 0.7);
  const HERO_WEIGHT = Number.isFinite(HERO_WEIGHT_RAW) ? HERO_WEIGHT_RAW : 0.7;
  const BACK_WEIGHT_RAW = Number(process.env.BACK_WEIGHT ?? 0.3);
  const BACK_WEIGHT = Number.isFinite(BACK_WEIGHT_RAW) ? BACK_WEIGHT_RAW : 0.3;
  const BACK_MIN_SIM_RAW = Number(process.env.BACK_MIN_SIM ?? 0.35);
  const BACK_MIN_SIM = Number.isFinite(BACK_MIN_SIM_RAW) ? BACK_MIN_SIM_RAW : 0.35;
  const BACK_KEYWORDS = (process.env.BACK_KEYWORDS ?? "supplement facts,nutrition facts,ingredients,active ingredients,directions,drug facts")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const FILENAME_BACK_HINTS = ["back", "facts", "ingredients", "supplement", "nutrition", "drug"];

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
      return { group, index: gi, groupId };
    });

  let firstImageDim = 0;
  let lastClipError: string | null = null;
  let clipEnabled = false;

    const imageVectorCache = new Map<string, Promise<number[] | null>>();
    const imageVectors = new Map<string, number[] | null>();
    const heroVectors = new Map<string, number[] | null>();
    const backVectors = new Map<string, number[] | null>();
    const heroOwnerByImage = new Map<string, string>();
    const folderCandidatesByGroup = new Map<string, CandidateDetail[]>();
  const fallbackAssignments = new Map<string, string[]>();

    const looksLikeBack = (ocrText: string | undefined, fileName: string | undefined): boolean => {
      const t = (ocrText || "").toLowerCase();
      const f = (fileName || "").toLowerCase();
      if (BACK_KEYWORDS.some((keyword) => keyword && t.includes(keyword))) return true;
      if (FILENAME_BACK_HINTS.some((hint) => hint && f.includes(hint))) return true;
      return false;
    };

    const normalizeUrl = (value: unknown): string | null => {
      if (typeof value === "string" && value.trim()) {
        return toDirectDropbox(value.trim());
      }
      return null;
    };

    const extractScanSourceImageUrl = (group: AnalyzedGroup): string | null => {
      const normalize = (value: unknown): string | null => {
        if (typeof value === "string" && value.trim()) {
          return toDirectDropbox(value.trim());
        }
        return null;
      };

      const directChecks: unknown[] = [
        (group as any)?.scanSourceImageUrl,
        (group as any)?.scan?.sourceImageUrl,
        (group as any)?.scan?.imageUrl,
        (group as any)?.seed?.scanSourceImageUrl,
        (group as any)?.seed?.sourceImageUrl,
        (group as any)?.seed?.imageUrl,
        (group as any)?.text?.sourceImageUrl,
        (group as any)?.text?.imageUrl,
      ];

      for (const candidate of directChecks) {
        const found = normalize(candidate);
        if (found) return found;
      }

      const arrayChecks: unknown[] = [
        (group as any)?.scanSources,
        (group as any)?.textSources,
        (group as any)?.textAnchors,
        (group as any)?.texts,
        (group as any)?.anchors,
      ];

      for (const collection of arrayChecks) {
        if (!Array.isArray(collection)) continue;
        for (const item of collection) {
          const found =
            normalize((item as any)?.sourceImageUrl) ||
            normalize((item as any)?.imageUrl) ||
            normalize(item);
          if (found) return found;
        }
      }

      return null;
    };

    const collectGroupTextForImage = (group: AnalyzedGroup, imageUrl: string): string[] => {
      const normalized = toDirectDropbox(imageUrl);
      const matches: string[] = [];
      const maybeCollections: unknown[] = [
        (group as any)?.textSources,
        (group as any)?.textAnchors,
        (group as any)?.texts,
        (group as any)?.scanSources,
      ];

      for (const collection of maybeCollections) {
        if (!Array.isArray(collection)) continue;
        for (const item of collection) {
          const sourceUrl = normalizeUrl((item as any)?.sourceImageUrl) || normalizeUrl((item as any)?.imageUrl);
          if (sourceUrl && sourceUrl === normalized) {
            const textFields = [
              (item as any)?.text,
              (item as any)?.content,
              (item as any)?.value,
              (item as any)?.label,
            ];
            for (const field of textFields) {
              if (typeof field === "string" && field.trim()) matches.push(field.trim());
            }
          }
        }
      }

      return matches;
    };

    const getImageVector = (url: string): Promise<number[] | null> => {
      const normalized = toDirectDropbox(url);
      if (!imageVectorCache.has(normalized)) {
        imageVectorCache.set(
          normalized,
          clipImageEmbedding(normalized)
            .then((vector) => {
              if (vector && !firstImageDim) firstImageDim = vector.length;
              imageVectors.set(normalized, vector);
              return vector;
            })
            .catch((err: any) => {
              if (!lastClipError) {
                lastClipError = err?.message ? String(err.message) : String(err ?? "image embedding failed");
              }
              imageVectors.set(normalized, null);
              return null;
            })
        );
      }
      return imageVectorCache.get(normalized)!;
    };

    for (const { group, groupId } of allGroups) {
      const rawImages = Array.isArray(group?.images) ? group.images : [];
      const cleaned = rawImages
        .map((img: unknown) => (typeof img === "string" ? toDirectDropbox(img) : ""))
        .filter((img: string) => img.length > 0);

      const scanSource = extractScanSourceImageUrl(group);
      const primaryHint =
        typeof group?.primaryImageUrl === "string" && group.primaryImageUrl
          ? toDirectDropbox(group.primaryImageUrl)
          : "";
      if (!cleaned.length) {
        const requestFolderKey = normalizeFolderKey(folder);
        const normalizedGroupFolder = normalizeFolderKey(typeof group?.folder === "string" ? group.folder : "");
        const scanSourceFolder = scanSource
          ? folderPath(tupleByUrl.get(scanSource)?.entry as DropboxEntry)
          : "";
        const fallbackFolderKey =
          normalizedGroupFolder || normalizeFolderKey(scanSourceFolder) || requestFolderKey;
        const folderMatches = fileTuples
          .filter((tuple) => normalizeFolderKey(folderPath(tuple.entry) || folder) === fallbackFolderKey)
          .map((tuple) => tuple.url);
        if (folderMatches.length) {
          const additions = folderMatches.filter((url) => !cleaned.includes(url));
          cleaned.push(...additions);
          group.images = cleaned.slice();
        }
      }
      const candidateDetails: CandidateDetail[] = cleaned.map((url) => {
        const tuple = tupleByUrl.get(url);
        const entry = tuple?.entry;
        const name = entry?.name || "";
        const insight = insightMap.get(url) as any;
        const textParts: string[] = [];
        if (typeof insight?.ocrText === "string") textParts.push(insight.ocrText);
        if (Array.isArray(insight?.textBlocks)) textParts.push(insight.textBlocks.join(" "));
        if (insight?.role) textParts.push(String(insight.role));
        if (insight?.hasVisibleText) textParts.push("visible text");
        const groupedText = collectGroupTextForImage(group, url);
        if (groupedText.length) textParts.push(groupedText.join(" "));
        return {
          url,
          name,
          folder: entry ? folderPath(entry) || folder : folder,
          order: urlOrder.has(url) ? urlOrder.get(url)! : Number.MAX_SAFE_INTEGER,
          ocrText: textParts.join(" ").trim(),
        };
      });
      let folderKey = normalizeFolderKey(typeof group?.folder === "string" ? group.folder : "");
      if (!folderKey && scanSource) {
        const scanEntry = tupleByUrl.get(scanSource)?.entry;
        if (scanEntry) folderKey = normalizeFolderKey(folderPath(scanEntry));
      }
      if (!folderKey && candidateDetails.length) {
        folderKey = normalizeFolderKey(candidateDetails[0].folder);
      }
      if (!folderKey) folderKey = normalizeFolderKey(folder);

      let groupCandidates = folderKey
        ? candidateDetails.filter((candidate) => normalizeFolderKey(candidate.folder) === folderKey)
        : candidateDetails.slice();
      if (!groupCandidates.length) {
        groupCandidates = candidateDetails.slice();
      }

      for (const candidate of groupCandidates) {
        const info = roleInfoFor(candidate.url) || roleInfoFor(candidate.name);
        candidate._role = info?.role;
        candidate._hasText = info?.hasVisibleText;
      }

      let front = groupCandidates.find((c) => c._role === "front");
      if (!front && scanSource) {
        const base = basenameFrom(scanSource);
        front = groupCandidates.find((c) => basenameFrom(c.url) === base);
      }
      if (!front) {
        front = groupCandidates
          .slice()
          .sort((a, b) => (b.ocrText?.length || 0) - (a.ocrText?.length || 0))[0];
      }
      if (!front) {
        front = groupCandidates[0] || candidateDetails[0];
      }

      const heroUrl = front?.url ? toDirectDropbox(front.url) : "";
      if (heroUrl) {
        group.heroUrl = heroUrl;
        group.primaryImageUrl = heroUrl;
        const existingIndex = cleaned.indexOf(heroUrl);
        if (existingIndex === -1) cleaned.unshift(heroUrl);
        else if (existingIndex > 0) {
          cleaned.splice(existingIndex, 1);
          cleaned.unshift(heroUrl);
        }
        heroOwnerByImage.set(heroUrl, groupId);
      } else {
        group.heroUrl = undefined;
      }

      const secondaryHint =
        typeof group?.secondaryImageUrl === "string" && group.secondaryImageUrl
          ? toDirectDropbox(group.secondaryImageUrl)
          : "";

      let back = groupCandidates.find((c) => c._role === "back" && c.url !== group.heroUrl);
      const heroVec = group.heroUrl ? await getImageVector(group.heroUrl) : null;

      if (!back) {
        back = groupCandidates.find((c) => c.url !== group.heroUrl && looksLikeBack(c.ocrText, c.name));
      }

      if (!back && heroVec) {
        const scored = await Promise.all(
          groupCandidates
            .filter((candidate) => candidate.url !== group.heroUrl)
            .map(async (candidate) => {
              const vec = await getImageVector(candidate.url);
              const sim = vec && heroVec && vec.length === heroVec.length ? cosine(vec, heroVec) : 0;
              return { candidate, sim };
            })
        );
        scored.sort((a, b) => b.sim - a.sim);
        if (scored[0]) back = scored[0].candidate;
      }

      if (back) {
        group.backUrl = back.url;
        group.secondaryImageUrl = back.url;
        await getImageVector(back.url);
      } else if (secondaryHint && secondaryHint !== group.heroUrl) {
        group.backUrl = secondaryHint;
        group.secondaryImageUrl = secondaryHint;
      } else {
        group.backUrl = undefined;
      }

      folderCandidatesByGroup.set(groupId, groupCandidates);

      heroVectors.set(groupId, heroVec);
      const backVec = group.backUrl ? await getImageVector(group.backUrl) : null;
      backVectors.set(groupId, backVec);

      group.images = cleaned;
    }

    if (CLIP_WEIGHT > 0) {
      await mapLimit(fileTuples, 4, async (tuple) => {
        await getImageVector(tuple.url);
      });
    }
    clipEnabled = firstImageDim > 0;
    if (!clipEnabled && !lastClipError) {
      lastClipError = "Image embedding unavailable";
    }

    if (!clipEnabled) {
      for (const { group, groupId } of allGroups) {
        const heroUrl = typeof group?.heroUrl === "string" ? group.heroUrl : "";
        const folderCandidates = folderCandidatesByGroup.get(groupId) || [];
        const secondaryHint =
          typeof group?.secondaryImageUrl === "string" && group.secondaryImageUrl
            ? group.secondaryImageUrl
            : "";
        const supportingHints = Array.isArray(group?.supportingImageUrls)
          ? group.supportingImageUrls.filter((url): url is string => typeof url === "string" && url.length > 0)
          : [];
        const folderUrls = [heroUrl, secondaryHint, ...supportingHints, ...folderCandidates.map((candidate) => candidate.url)]
          .filter((url): url is string => Boolean(url))
          .filter((url, idx, list) => list.indexOf(url) === idx);

        let second: string | undefined;
        if (typeof group?.backUrl === "string" && group.backUrl && group.backUrl !== heroUrl) {
          second = group.backUrl;
        }
        if (!second && secondaryHint && secondaryHint !== heroUrl) {
          second = secondaryHint;
        }
        if (!second) {
          const hinted = folderCandidates.find((candidate) => looksLikeBack(candidate.ocrText, candidate.name));
          if (hinted) second = hinted.url;
        }
        if (!second) {
          second = folderUrls.find((url) => url !== heroUrl);
        }

        const fallbackPrimary = [heroUrl, second].filter((url): url is string => Boolean(url));
        const fallbackImages = STRICT_TWO_IF_SMALL
          ? fallbackPrimary.slice(0, 2)
          : Array.from(new Set(folderUrls.length ? folderUrls : fallbackPrimary));

        const uniqueFallback = Array.from(new Set(fallbackImages.length ? fallbackImages : fallbackPrimary));
        group.backUrl = uniqueFallback.length > 1 ? uniqueFallback[1] : undefined;
        group.secondaryImageUrl = group.backUrl || (secondaryHint && secondaryHint !== heroUrl ? secondaryHint : undefined);

        group.images = uniqueFallback;
        fallbackAssignments.set(groupId, uniqueFallback);
      }
    }

    const looksDummyByMeta = (entry: DropboxEntry): boolean => {
      const size = Number(entry?.size || 0);
      if (size > 0 && size < 10 * 1024) return true;
      const dims = entry?.media_info?.metadata?.dimensions;
      const width = Number(dims?.width || 0);
      const height = Number(dims?.height || 0);
      if (width && height && (width < 200 || height < 200)) return true;
      return false;
    };

    type ScoreResult = {
      base: number;
      total: number;
      clipContribution: number;
      clipSim: number;
      clipHero: number;
      clipBack: number;
      components?: DebugComponent[];
    };

    const clipSimByGroup = new Map<string, Map<string, number>>();

    const scoreImageForGroup = (
      tuple: { entry: DropboxEntry; url: string },
      gi: number,
      captureDetails = false
    ): ScoreResult => {
      const groupId = allGroups[gi].groupId;
      const insight = insightMap.get(tuple.url);
      let baseScore = 0;
      const components = captureDetails ? ([] as DebugComponent[]) : undefined;
      const add = (label: string, value: number, detail?: string) => {
        baseScore += value;
        if (components && value !== 0) components.push({ label, value, detail });
      };

      const path = String(tuple.entry?.path_display || tuple.entry?.path_lower || "");
      const baseName = String(tuple.entry?.name || "");
      const nameTokens = new Set(tokenize(baseName));
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

      let simHero = 0;
      let simBack = 0;
      let clipSim = 0;
      if (CLIP_WEIGHT > 0 && clipEnabled) {
        const heroVec = heroVectors.get(groupId) || null;
        const backVec = backVectors.get(groupId) || null;
        const imgVec = imageVectors.get(tuple.url) ?? null;
        if (imgVec && heroVec && imgVec.length === heroVec.length) simHero = cosine(imgVec, heroVec);
        if (imgVec && backVec && imgVec.length === backVec.length) simBack = cosine(imgVec, backVec);
        clipSim = backVec ? HERO_WEIGHT * simHero + BACK_WEIGHT * simBack : simHero;
      }

      let clipContribution = 0;
      if (CLIP_WEIGHT > 0 && clipEnabled && clipSim >= CLIP_MIN_SIM) {
        clipContribution = Math.round(clipSim * CLIP_WEIGHT);
      }

      if (components) {
        components.push({ label: "clip-hero", value: Number((simHero * 100).toFixed(1)), detail: simHero.toFixed(3) });
        if (backVectors.get(groupId)) {
          components.push({ label: "clip-back", value: Number((simBack * 100).toFixed(1)), detail: simBack.toFixed(3) });
        }
        components.push({ label: "clip", value: clipContribution, detail: clipSim.toFixed(3) });
      }

      const total = baseScore + clipContribution;

      return { base: baseScore, total, clipContribution, clipSim, clipHero: simHero, clipBack: simBack, components };
    };

    type Rank = { groupId: string; sim: number };
    const ranksByImage = new Map<string, Rank[]>();
  const marginByGroupImage = new Map<string, Map<string, number>>();

    for (const tuple of fileTuples) {
      for (let gi = 0; gi < groups.length; gi++) {
        const result = scoreImageForGroup(tuple, gi, debugEnabled);
        const groupId = allGroups[gi].groupId;

        if (!clipSimByGroup.has(groupId)) clipSimByGroup.set(groupId, new Map<string, number>());
        clipSimByGroup.get(groupId)!.set(tuple.url, result.clipSim);

        if (result.clipSim >= CLIP_MIN_SIM) {
          const ranks = ranksByImage.get(tuple.url) || [];
          ranks.push({ groupId, sim: result.clipSim });
          ranksByImage.set(tuple.url, ranks);
        }

        if (debugCandidatesPerGroup) {
          const components = result.components ? [...result.components] : [];
          debugCandidatesPerGroup[gi].push({
            url: tuple.url,
            name: tuple.entry?.name || "",
            path: tuple.entry?.path_display || tuple.entry?.path_lower || "",
            order: urlOrder.has(tuple.url) ? urlOrder.get(tuple.url)! : Number.MAX_SAFE_INTEGER,
            base: result.base,
            total: result.total,
            clipContribution: result.clipContribution,
            clipSimilarity: result.clipSim,
            passedThreshold: result.total >= MIN_ASSIGN,
            components,
          });
        }
      }
      if (!ranksByImage.has(tuple.url)) {
        ranksByImage.set(tuple.url, []);
      }
    }

    for (const [imageUrl, ranks] of ranksByImage.entries()) {
      ranks.sort((a, b) => b.sim - a.sim);
      if (!ranks.length) continue;
      for (const rank of ranks) {
        let bestOther = Number.NEGATIVE_INFINITY;
        for (const contender of ranks) {
          if (contender.groupId === rank.groupId) continue;
          if (contender.sim > bestOther) bestOther = contender.sim;
        }
        const comparable = Number.isFinite(bestOther) ? bestOther : 0;
        const margin = rank.sim - comparable;
        let groupMargins = marginByGroupImage.get(rank.groupId);
        if (!groupMargins) {
          groupMargins = new Map<string, number>();
          marginByGroupImage.set(rank.groupId, groupMargins);
        }
        groupMargins.set(imageUrl, margin);
      }
    }

    const assignedByGroup = new Map<string, Set<string>>();
    const assignedImageTo = new Map<string, string>();
    const dupesUsed = new Map<string, number>();

    if (clipEnabled) {
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

      if (HERO_LOCK) {
        for (const { group, groupId } of allGroups) {
          if (group.heroUrl) {
            addToGroup(groupId, group.heroUrl);
          }
        }
      }

      for (const [imageUrl, ranks] of ranksByImage.entries()) {
        if (!ranks.length) continue;
        const best = ranks[0];
        const next = ranks[1];
        const decisive = !next || best.sim - next.sim >= CLIP_MARGIN;
        if (decisive && !assignedImageTo.has(imageUrl)) {
          addToGroup(best.groupId, imageUrl);
        }
      }

      for (const { groupId } of allGroups) {
        const set = ensureGroupSet(groupId);
        let remaining = Math.max(0, MIN_ASSIGN - set.size);
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

      for (const [imageUrl, ranks] of ranksByImage.entries()) {
        const holders = allGroups.filter((entry) => ensureGroupSet(entry.groupId).has(imageUrl));
        if (holders.length <= 1) {
          if (holders.length === 1) assignedImageTo.set(imageUrl, holders[0].groupId);
          continue;
        }

        const heroOwner = HERO_LOCK ? heroOwnerByImage.get(imageUrl) : undefined;
        if (heroOwner) {
          assignedImageTo.set(imageUrl, heroOwner);
          for (const holder of holders) {
            if (holder.groupId !== heroOwner) {
              ensureGroupSet(holder.groupId).delete(imageUrl);
            }
          }
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

      for (const { groupId } of allGroups) {
        const set = assignedByGroup.get(groupId);
        if (!set) continue;
        for (const imageUrl of set) {
          if (!assignedImageTo.has(imageUrl)) assignedImageTo.set(imageUrl, groupId);
        }
      }
    } else {
      for (const { group, groupId } of allGroups) {
        const fallback = fallbackAssignments.get(groupId) || (
          Array.isArray(group?.images) ? group.images.slice(0, STRICT_TWO_IF_SMALL ? 2 : group.images.length) : []
        );
        const uniqueSet = new Set<string>();
        for (const url of fallback) {
          if (!url) continue;
          uniqueSet.add(url);
          assignedImageTo.set(url, groupId);
        }
        assignedByGroup.set(groupId, uniqueSet);
      }
    }

    const assignedLists = groups.map((_, gi) => {
      const groupId = allGroups[gi].groupId;
      return Array.from(assignedByGroup.get(groupId) ?? []);
    });

    if (debugCandidatesPerGroup) {
      for (let gi = 0; gi < groups.length; gi++) {
        const assignedSet = new Set(assignedLists[gi]);
        const marginMap = marginByGroupImage.get(allGroups[gi].groupId);
        debugCandidatesPerGroup[gi] = debugCandidatesPerGroup[gi]
          .map((entry) => ({
            ...entry,
            assigned: assignedSet.has(entry.url),
            margin: marginMap?.get(entry.url) ?? null,
          }))
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

      const heroUrl = typeof group?.heroUrl === "string" ? group.heroUrl : null;
      const clipScores = clipSimByGroup.get(allGroups[gi].groupId) || new Map<string, number>();

      const heroPref = typeof group?.heroUrl === "string" ? group.heroUrl : null;
      const backPref = typeof group?.backUrl === "string" ? group.backUrl : null;

      unique = unique
        .map((url, idx) => {
          const entry = tupleByUrl.get(url);
          const tokens = tokenize(entry?.entry?.name || url);
          let bias = 0;
          if (tokens.some((token) => POS_NAME_TOKENS.has(token))) bias -= 1;
          if (tokens.some((token) => NEG_NAME_TOKENS.has(token))) bias += 1;
          const insight = insightForUrl(url);
          if (insight?.role === "front") bias -= 2;
          if (insight?.role === "back") bias += 2;
          const order = urlOrder.has(url) ? urlOrder.get(url)! : Number.MAX_SAFE_INTEGER + idx;
          const sim = clipScores.get(url) ?? Number.NEGATIVE_INFINITY;
          return { url, idx, bias, order, sim };
        })
        .sort((a, b) => {
          if (heroPref) {
            if (a.url === heroPref && b.url !== heroPref) return -1;
            if (b.url === heroPref && a.url !== heroPref) return 1;
          }
          if (b.sim !== a.sim) return b.sim - a.sim;
          if (a.bias !== b.bias) return a.bias - b.bias;
          return a.order - b.order;
        })
        .map((item) => item.url)
        .slice(0, 12);

      const rest = unique.filter((url) => url !== heroPref && url !== backPref);
      const orderedImages: string[] = [];
      const seenImages = new Set<string>();
      const pushOrdered = (url: string | null) => {
        if (!url) return;
        if (seenImages.has(url)) return;
        seenImages.add(url);
        orderedImages.push(url);
      };

      pushOrdered(heroPref);
      pushOrdered(backPref);
      rest.forEach((url) => pushOrdered(url));

      let finalImages = orderedImages.slice(0, 12);
      const candidateCount = (folderCandidatesByGroup.get(allGroups[gi].groupId) || []).length;
      if (candidateCount <= 2) {
        finalImages = finalImages.slice(0, 2);
      }

      if (heroPref) group.primaryImageUrl = heroPref;
      if (backPref && backPref !== heroPref) group.secondaryImageUrl = backPref;

      normalizedGroups.push({ ...group, images: finalImages });
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
  links: linkPersist.size ? Object.fromEntries(linkPersist) : undefined,
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
        const roleCandidates = folderCandidatesByGroup.get(allGroups[gi].groupId) || [];
        return {
          groupId: group?.groupId || `group_${gi + 1}`,
          name: displayName,
          heroUrl: typeof group?.heroUrl === "string" ? group.heroUrl : null,
          backUrl: typeof group?.backUrl === "string" ? group.backUrl : null,
          primaryImageUrl: typeof group?.primaryImageUrl === "string" ? group.primaryImageUrl : null,
          secondaryImageUrl: typeof group?.secondaryImageUrl === "string" ? group.secondaryImageUrl : null,
          supportingImageUrls: Array.isArray(group?.supportingImageUrls) ? group.supportingImageUrls.slice(0, 6) : [],
          clipEnabled,
          reason: clipEnabled
            ? "CLIP image enabled"
            : "CLIP image disabled; used fallback (hero + back hint)",
          roles: roleCandidates.map((candidate) => ({
            url: candidate.url,
            role: candidate._role ?? null,
            hasText: Boolean(candidate._hasText),
          })),
          candidates: entries.slice(0, 20),
        };
      });

      const providerMeta = clipProviderInfo();
      const clipDebug: Record<string, unknown> = {
        ...providerMeta,
        weight: CLIP_WEIGHT,
        minSimilarity: CLIP_MIN_SIM,
        imgDim: firstImageDim,
        enabled: clipEnabled,
        anchors: {
          heroWeight: HERO_WEIGHT,
          backWeight: BACK_WEIGHT,
          backMinSim: BACK_MIN_SIM,
          margin: CLIP_MARGIN,
        },
      };
      const fallbackClipError =
        lastClipError ||
        (!process.env.HF_API_TOKEN
          ? "HF_API_TOKEN missing"
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
