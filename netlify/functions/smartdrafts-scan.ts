import type { Handler } from "@netlify/functions";
import { createHash } from "node:crypto";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";
import { runAnalysis, type ImageInsight } from "../../src/lib/analyze-core.js";
import { clipTextEmbedding, clipImageEmbedding, cosine } from "../../src/lib/clip.js";
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

const METHODS = "POST, OPTIONS";
const MAX_IMAGES = Math.max(1, Math.min(100, Number(process.env.SMARTDRAFT_MAX_IMAGES || 100)));

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
    if (!force && cached && cached.signature === signature && Array.isArray(cached.groups) && cached.groups.length) {
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

    const allowed = await canConsumeImages(user.userId, urls.length);
    if (!allowed) {
      return jsonResponse(429, { ok: false, error: "Daily image quota exceeded" }, originHdr, METHODS);
    }
    await consumeImages(user.userId, urls.length);

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

    const rawMinAssign = Number(process.env.SMARTDRAFT_MIN_ASSIGN ?? 3);
    const MIN_ASSIGN = Number.isFinite(rawMinAssign) ? rawMinAssign : 3;

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

    const groupPrompts = groups.map((group) => {
      const promptParts = [group?.brand, group?.product, group?.variant]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean);
      if (promptParts.length) return promptParts.join(" ");
      if (typeof group?.product === "string" && group.product.trim()) return group.product.trim();
      return "product";
    });

    const textEmbeddings = await Promise.all(
      groupPrompts.map(async (prompt) => {
        try {
          return await clipTextEmbedding(prompt);
        } catch {
          return null;
        }
      })
    );

    const clipWeightRaw = Number(process.env.CLIP_WEIGHT ?? 20);
    const CLIP_WEIGHT = Number.isFinite(clipWeightRaw) ? clipWeightRaw : 20;
    const clipMinSimRaw = Number(process.env.CLIP_MIN_SIM ?? 0.12);
    const CLIP_MIN_SIM = Number.isFinite(clipMinSimRaw) ? clipMinSimRaw : 0.12;
    const clipEnabled = CLIP_WEIGHT > 0 && textEmbeddings.some((emb) => Array.isArray(emb) && emb.length > 0);

    const imageEmbeddingCache = new Map<string, Promise<number[] | null>>();

    const getImageEmbedding = (url: string): Promise<number[] | null> => {
      const normalized = toDirectDropbox(url);
      if (!imageEmbeddingCache.has(normalized)) {
        const promise = clipImageEmbedding(normalized).catch(() => null);
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

    const scoreImageForGroup = (tuple: { entry: DropboxEntry; url: string }, gi: number): number => {
      const insight = insightMap.get(tuple.url);
      let score = 0;

      const path = String(tuple.entry?.path_display || tuple.entry?.path_lower || "");
      const base = String(tuple.entry?.name || "");
      const nameTokens = new Set(tokenize(base));
      const allTokens = new Set<string>([...tokenize(path), ...nameTokens]);

      for (const token of groupTokens[gi] || []) {
        if (allTokens.has(token)) score += 3;
      }

      for (const token of nameTokens) {
        if (POS_NAME_TOKENS.has(token)) score += 12;
        if (NEG_NAME_TOKENS.has(token)) score -= 10;
      }

  if (insight?.hasVisibleText === true) score += 6;
  else if (insight?.hasVisibleText === false) score -= 5;

      if (insight?.role && ROLE_WEIGHTS[insight.role] !== undefined) {
        score += ROLE_WEIGHTS[insight.role];
      }

      if (insight?.dominantColor && COLOR_WEIGHTS[insight.dominantColor] !== undefined) {
        score += COLOR_WEIGHTS[insight.dominantColor];
      }

      if ((desiredByGroup[gi] || []).includes(tuple.url)) score += 10;

      const confidence = Number(groups[gi]?.confidence || 0);
      score += Math.min(5, Math.max(0, Math.round(confidence)));

      if (looksDummyByMeta(tuple.entry)) score -= 8;

      const dims = tuple.entry?.media_info?.metadata?.dimensions;
      const width = Number(dims?.width || 0);
      const height = Number(dims?.height || 0);
      if (width > 0 && height > 0) {
        const megaPixels = (width * height) / 1_000_000;
        if (megaPixels >= 3.5) score += 8;
        else if (megaPixels >= 2) score += 6;
        else if (megaPixels >= 1) score += 4;
        else if (megaPixels >= 0.6) score += 1;
        else score -= 6;

        const aspect = width / height;
        if (aspect > 0) {
          if (aspect >= 0.8 && aspect <= 1.25) score += 3;
          else if (aspect >= 0.6 && aspect <= 1.45) score += 1;
          else if (aspect <= 0.45 || aspect >= 1.8) score -= 4;
        }
      }

      return score;
    };

    const targetPerGroup = groups.map((group, gi) => {
      const desired = desiredByGroup[gi]?.length || 0;
      return Math.min(12, Math.max(desired, 1));
    });

    const imageEmbeddings = await Promise.all(
      fileTuples.map((tuple) => (clipEnabled ? getImageEmbedding(tuple.url) : Promise.resolve(null)))
    );

    const pairScores: Array<{ tupleIndex: number; groupIndex: number; score: number }> = [];

    for (let ti = 0; ti < fileTuples.length; ti++) {
      const tuple = fileTuples[ti];
      for (let gi = 0; gi < groups.length; gi++) {
        const base = scoreImageForGroup(tuple, gi);
        if (!Number.isFinite(base)) continue;

        let combined = base;
        if (clipEnabled) {
          const textEmb = textEmbeddings[gi];
          const imageEmb = imageEmbeddings[ti];
          if (textEmb && imageEmb && textEmb.length === imageEmb.length) {
            const similarity = cosine(imageEmb, textEmb);
            if (Number.isFinite(similarity)) {
              combined += similarity < CLIP_MIN_SIM ? -2 : CLIP_WEIGHT * similarity;
            }
          }
        }

        if (!Number.isFinite(combined)) continue;
        pairScores.push({ tupleIndex: ti, groupIndex: gi, score: combined });
      }
    }

    pairScores.sort((a, b) => b.score - a.score);

    const assignedByGroup: string[][] = groups.map(() => []);
    const groupCounts = groups.map(() => 0);
    const tupleAssigned = new Array<boolean>(fileTuples.length).fill(false);

    const tryAssign = (minScore: number) => {
      for (const pair of pairScores) {
        if (tupleAssigned[pair.tupleIndex]) continue;
        if (groupCounts[pair.groupIndex] >= targetPerGroup[pair.groupIndex]) continue;
        if (pair.score < minScore) continue;

        assignedByGroup[pair.groupIndex].push(fileTuples[pair.tupleIndex].url);
        tupleAssigned[pair.tupleIndex] = true;
        groupCounts[pair.groupIndex]++;
      }
    };

    tryAssign(MIN_ASSIGN);
    tryAssign(Number.NEGATIVE_INFINITY);

    const usedUrls = new Set<string>();
    assignedByGroup.forEach((urls) => urls.forEach((url) => usedUrls.add(url)));

    let reassignedCount = 0;
    fileTuples.forEach((tuple) => {
      const candidates = urlToGroups.get(tuple.url) || [];
      if (candidates.length > 1) reassignedCount++;
    });

    const normalizedGroups: any[] = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const seen = new Set<string>();
      let unique = assignedByGroup[gi].filter((url) => {
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

    return jsonResponse(200, {
      ok: true,
      folder,
      signature,
      count: payloadGroups.length,
      warnings,
      groups: payloadGroups,
      orphans,
    }, originHdr, METHODS);
  } catch (err: any) {
    return jsonResponse(500, { ok: false, error: err?.message || String(err) }, originHdr, METHODS);
  }
};
