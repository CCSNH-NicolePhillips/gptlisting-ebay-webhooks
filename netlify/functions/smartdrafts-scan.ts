import type { Handler } from "@netlify/functions";
import { createHash } from "node:crypto";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";
import { runAnalysis } from "../../src/lib/analyze-core.js";
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

    const urlOrder = new Map<string, number>();
    fileTuples.forEach((tuple, idx) => {
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
        .replace(/[_\-]+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(Boolean);

    const groupTokens: string[][] = groups.map((group) => {
      const parts: string[] = [];
      if (group?.brand) parts.push(String(group.brand));
      if (group?.product) parts.push(String(group.product));
      if (group?.variant) parts.push(String(group.variant));
      if (Array.isArray(group?.claims)) parts.push(...group.claims.slice(0, 8).map(String));
      return tokenize(parts.join(" "));
    });

    const isLikelyDummy = (entry: DropboxEntry): boolean => {
      const name = String(entry?.name || "");
      const size = Number(entry?.size || 0);
      const nameTokens = tokenize(name);
      const badNames = ["dummy", "placeholder", "test", "black", "white", "bw", "barcode", "back", "_bg", "blank"];
      if (badNames.some((token) => nameTokens.includes(token))) return true;
      if (size > 0 && size < 10 * 1024) return true;
      const dims = entry?.media_info?.metadata?.dimensions;
      const width = Number(dims?.width || 0);
      const height = Number(dims?.height || 0);
      if (width && height && (width < 200 || height < 200)) return true;
      return false;
    };

    const scoreImageForGroup = (tuple: { entry: DropboxEntry; url: string }, gi: number): number => {
      if (isLikelyDummy(tuple.entry)) return -50;

      let score = 0;
      const path = String(tuple.entry?.path_display || tuple.entry?.path_lower || "");
      const base = String(tuple.entry?.name || "");
      const imgTokens = new Set<string>([...tokenize(path), ...tokenize(base)]);
      const tokens = groupTokens[gi] || [];
      for (const token of tokens) {
        if (imgTokens.has(token)) score += 3;
      }
      if ((desiredByGroup[gi] || []).includes(tuple.url)) score += 10;
      const confidence = typeof groups[gi]?.confidence === "number" ? groups[gi]!.confidence : 0;
      score += Math.min(5, Math.max(0, Math.round(confidence)));
      return score;
    };

    const assignedByGroup: string[][] = groups.map(() => []);
    const assignmentCounts = groups.map(() => 0);
    let reassignedCount = 0;
    const usedUrls = new Set<string>();

    const pickTargetGroupByScore = (tuple: { entry: DropboxEntry; url: string }, candidates: number[]): number => {
      const scored = candidates.map((idx) => ({ idx, score: scoreImageForGroup(tuple, idx) }));
      let bestScore = scored.reduce((acc, item) => Math.max(acc, item.score), Number.NEGATIVE_INFINITY);
      const top = scored.filter((item) => item.score === bestScore).map((item) => item.idx);
      let winner = top[0];
      for (const idx of top.slice(1)) {
        if (assignmentCounts[idx] < assignmentCounts[winner]) {
          winner = idx;
          continue;
        }
        if (assignmentCounts[idx] === assignmentCounts[winner]) {
          const confIdx = Number(groups[idx]?.confidence || 0);
          const confWin = Number(groups[winner]?.confidence || 0);
          if (confIdx > confWin) {
            winner = idx;
            continue;
          }
          if (confIdx === confWin && idx < winner) {
            winner = idx;
          }
        }
      }
      return winner;
    };

    for (const tuple of fileTuples) {
      const url = tuple.url;
      if (usedUrls.has(url)) continue;
      const candidates = (urlToGroups.get(url) || []).filter((gi) => assignmentCounts[gi] < 12);
      if (!candidates.length) continue;
      const target = candidates.length === 1 ? candidates[0] : pickTargetGroupByScore(tuple, candidates);
      if (candidates.length > 1) reassignedCount++;
      assignedByGroup[target].push(url);
      assignmentCounts[target] = Math.min(12, assignedByGroup[target].length);
      usedUrls.add(url);
    }

    const normalizedGroups = groups.map((group, gi) => {
      const seen = new Set<string>();
      let unique = assignedByGroup[gi].filter((url) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });

      if (!unique.length) {
        const primary = fileTuples.find((tuple) => !usedUrls.has(tuple.url) && scoreImageForGroup(tuple, gi) > 0);
        if (primary) {
          unique = [primary.url];
          usedUrls.add(primary.url);
        } else {
          const fallback = fileTuples.find((tuple) => !usedUrls.has(tuple.url));
          if (fallback) {
            unique = [fallback.url];
            usedUrls.add(fallback.url);
          }
        }
      }

      // Fill gaps with closest matches from remaining files
      const desiredCount = Math.max(1, desiredByGroup[gi].length || 0);
      if (unique.length < Math.min(12, desiredCount)) {
        const targetCount = Math.min(12, desiredCount);
        const available = fileTuples
          .filter((tuple) => !usedUrls.has(tuple.url))
          .map((tuple) => {
            const score = scoreImageForGroup(tuple, gi);
            return {
              tuple,
              score,
              order: urlOrder.has(tuple.url) ? urlOrder.get(tuple.url)! : Number.MAX_SAFE_INTEGER,
            };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.order - b.order;
          });

        for (const item of available) {
          if (unique.length >= targetCount) break;
          if (usedUrls.has(item.tuple.url)) continue;
          unique.push(item.tuple.url);
          usedUrls.add(item.tuple.url);
        }
      }

      unique = unique.slice(0, 12);
      unique.forEach((url) => usedUrls.add(url));

      const sorted = unique.sort((a, b) => {
        const orderA = urlOrder.has(a) ? urlOrder.get(a)! : Number.MAX_SAFE_INTEGER;
        const orderB = urlOrder.has(b) ? urlOrder.get(b)! : Number.MAX_SAFE_INTEGER;
        return orderA - orderB;
      });

      return { ...group, images: sorted };
    });

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
