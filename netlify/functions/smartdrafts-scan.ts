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
};

type OrphanImage = {
  url: string;
  name: string;
  folder: string;
};

type GroupScoringMeta = {
  weights: Map<string, number>;
  phrases: Array<{ text: string; weight: number }>;
};

type TupleTokenInfo = {
  tokens: Set<string>;
  haystack: string;
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

function tokenizeText(input: string | undefined, minLength = 3): string[] {
  if (!input) return [];
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= minLength);
}

function addWeightedTokens(weights: Map<string, number>, value: string | undefined, weight: number, minLength = 3) {
  if (!value) return;
  for (const token of tokenizeText(value, minLength)) {
    const existing = weights.get(token) || 0;
    if (weight > existing) weights.set(token, weight);
  }
}

function addPhrase(phrases: Array<{ text: string; weight: number }>, value: string | undefined, weight: number) {
  if (!value) return;
  const clean = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (clean.length < 3) return;
  phrases.push({ text: clean, weight });
}

function buildGroupMeta(group: any): GroupScoringMeta {
  const weights = new Map<string, number>();
  const phrases: Array<{ text: string; weight: number }> = [];

  addWeightedTokens(weights, group.brand, 6);
  addWeightedTokens(weights, group.product, 5);
  addWeightedTokens(weights, group.variant, 4);
  addWeightedTokens(weights, group.size, 3, 2);
  addWeightedTokens(weights, group.name, 4);
  addWeightedTokens(weights, group.folder, 2);
  if (Array.isArray(group.claims)) {
    for (const claim of group.claims) addWeightedTokens(weights, String(claim || ""), 2);
  }
  if (Array.isArray(group.features)) {
    for (const feat of group.features) addWeightedTokens(weights, String(feat || ""), 2);
  }
  if (Array.isArray(group.keywords)) {
    for (const kw of group.keywords) addWeightedTokens(weights, String(kw || ""), 2);
  }
  if (group.category) {
    const catLabel = typeof group.category === "object" ? group.category.title || group.category.name : group.category;
    addWeightedTokens(weights, catLabel, 2);
  }

  addPhrase(phrases, group.brand, 4);
  addPhrase(phrases, group.product, 4);
  addPhrase(phrases, group.variant, 3);
  addPhrase(phrases, group.name, 3);

  return { weights, phrases };
}

function buildTupleInfo(tuple: { entry: DropboxEntry; url: string }): TupleTokenInfo {
  const textParts = [tuple.entry.name || "", tuple.entry.path_display || "", tuple.entry.path_lower || ""];
  const haystack = textParts.join(" ").toLowerCase();
  const tokens = new Set(tokenizeText(haystack, 2));
  return { tokens, haystack };
}

function scoreTuple(meta: GroupScoringMeta, tupleInfo: TupleTokenInfo): number {
  let score = 0;
  meta.weights.forEach((weight, token) => {
    if (tupleInfo.tokens.has(token)) score += weight;
  });
  for (const phrase of meta.phrases) {
    if (tupleInfo.haystack.includes(phrase.text)) score += phrase.weight;
  }
  return score;
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

    const assignedByGroup: string[][] = groups.map(() => []);
    const assignmentCounts = groups.map(() => 0);
    const groupMeta = groups.map((group) => buildGroupMeta(group));
    const tupleInfoCache = new Map<string, TupleTokenInfo>();
    let reassignedCount = 0;
    const usedUrls = new Set<string>();

    const pickTargetGroup = (candidates: number[]): number => {
      let best = candidates[0];
      for (const idx of candidates.slice(1)) {
        if (assignmentCounts[idx] < assignmentCounts[best]) {
          best = idx;
          continue;
        }
        if (assignmentCounts[idx] === assignmentCounts[best]) {
          const confIdx = typeof groups[idx]?.confidence === "number" ? groups[idx]!.confidence : 0;
          const confBest = typeof groups[best]?.confidence === "number" ? groups[best]!.confidence : 0;
          if (confIdx > confBest) {
            best = idx;
            continue;
          }
          if (confIdx === confBest && idx < best) {
            best = idx;
          }
        }
      }
      return best;
    };

    for (const tuple of fileTuples) {
      const url = tuple.url;
      if (usedUrls.has(url)) continue;
      const candidates = (urlToGroups.get(url) || []).filter((gi) => assignmentCounts[gi] < 12);
      if (!candidates.length) continue;
      let target = candidates.length === 1 ? candidates[0] : -1;
      if (candidates.length > 1) {
        const info = tupleInfoCache.get(url) || buildTupleInfo(tuple);
        if (!tupleInfoCache.has(url)) tupleInfoCache.set(url, info);
        let bestScore = -1;
        let bestIdx = candidates[0];
        let bestConfidence = typeof groups[bestIdx]?.confidence === "number" ? groups[bestIdx]!.confidence : 0;
        for (const idx of candidates) {
          const score = scoreTuple(groupMeta[idx], info);
          const confidence = typeof groups[idx]?.confidence === "number" ? groups[idx]!.confidence : 0;
          if (score > bestScore) {
            bestScore = score;
            bestIdx = idx;
            bestConfidence = confidence;
          } else if (score === bestScore) {
            if (confidence > bestConfidence) {
              bestIdx = idx;
              bestConfidence = confidence;
            } else if (confidence === bestConfidence && assignmentCounts[idx] < assignmentCounts[bestIdx]) {
              bestIdx = idx;
            }
          }
        }
        if (bestScore <= 0) {
          bestIdx = pickTargetGroup(candidates);
        }
        target = bestIdx;
        reassignedCount++;
      }
      assignedByGroup[target].push(url);
      assignmentCounts[target] = assignedByGroup[target].length;
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
        const fallback = fileTuples.find((tuple) => !usedUrls.has(tuple.url));
        if (fallback) {
          unique = [fallback.url];
          usedUrls.add(fallback.url);
        }
      }

      // Fill gaps with closest matches from remaining files
      if (unique.length < Math.min(12, Math.max(desiredByGroup[gi].length, 3))) {
        const infoForGroup = groupMeta[gi];
        const targetCount = Math.min(12, Math.max(desiredByGroup[gi].length || 0, 3));
        const available = fileTuples
          .filter((tuple) => !usedUrls.has(tuple.url))
          .map((tuple) => {
            const info = tupleInfoCache.get(tuple.url) || buildTupleInfo(tuple);
            if (!tupleInfoCache.has(tuple.url)) tupleInfoCache.set(tuple.url, info);
            const score = scoreTuple(infoForGroup, info);
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
