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
    if (cached && cached.signature === signature && Array.isArray(cached.groups) && cached.groups.length) {
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

    const urls = sanitizeUrls(fileTuples.map((tuple) => tuple.url));
    if (!urls.length) {
      const fallbackGroups = buildFallbackGroups(fileTuples);
      return jsonResponse(200, {
        ok: true,
        folder,
        signature,
        count: fallbackGroups.length,
        warnings: ["No usable image URLs; generated fallback groups."],
        groups: hydrateGroups(fallbackGroups, folder),
      }, originHdr, METHODS);
    }

    const allowed = await canConsumeImages(user.userId, urls.length);
    if (!allowed) {
      return jsonResponse(429, { ok: false, error: "Daily image quota exceeded" }, originHdr, METHODS);
    }
    await consumeImages(user.userId, urls.length);

    const analysis = await runAnalysis(urls, 12, { skipPricing: true });
    let groups = Array.isArray(analysis?.groups) ? analysis.groups : [];
    let warnings: string[] = Array.isArray(analysis?.warnings) ? analysis.warnings : [];

    if (!groups.length) {
      const fallback = buildFallbackGroups(fileTuples);
      groups = fallback;
      warnings = [...warnings, "Vision grouping returned no results; falling back to folder grouping."];
    }

    const payloadGroups = hydrateGroups(groups, folder);

    const cachePayload: SmartDraftGroupCache = {
      signature,
      groups: payloadGroups,
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
    }, originHdr, METHODS);
  } catch (err: any) {
    return jsonResponse(500, { ok: false, error: err?.message || String(err) }, originHdr, METHODS);
  }
};
