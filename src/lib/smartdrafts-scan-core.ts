import { createHash } from "node:crypto";
import { STRICT_TWO_ONLY, USE_NEW_SORTER, USE_ROLE_SORTING, USE_CLIP } from "../config.js";
import { userScopedKey } from "./_auth.js";
import { tokensStore } from "./_blobs.js";
import { runAnalysis } from "./analyze-core.js";
import { clipImageEmbedding, clipProviderInfo, clipTextEmbedding, cosine } from "./clip-client-split.js";
import type { ImageInsight } from "./image-insight.js";
import { sanitizeUrls, toDirectDropbox } from "./merge.js";
import { canConsumeImages, consumeImages } from "./quota.js";
import {
    getCachedSmartDraftGroups,
    makeCacheKey,
    setCachedSmartDraftGroups,
    type SmartDraftGroupCache,
} from "./smartdrafts-store.js";
import { frontBackStrict } from "./sorter/frontBackStrict.js";
import { urlKey } from "../utils/urlKey.js";
import { sanitizeInsightUrl } from "../utils/urlSanitize.js";
import { makeDisplayUrl } from "../utils/displayUrl.js";
import { buildRoleMap } from "../utils/roles.js";
import { normBrand, tokenize, jaccard, categoryCompat } from "../utils/groupingHelpers.js";
import { finalizeDisplayUrls } from "../utils/finalizeDisplay.js";

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

const MAX_IMAGES = Math.max(1, Math.min(100, Number(process.env.SMARTDRAFT_MAX_IMAGES || 100)));

export type SmartDraftScanOptions = {
  userId: string;
  folder: string;
  force?: boolean;
  limit?: number;
  debug?: boolean | string;
  skipQuota?: boolean;
};

export type SmartDraftScanBody = {
  ok: boolean;
  error?: string;
  cached?: boolean;
  folder?: string;
  signature?: string | null;
  count?: number;
  warnings?: string[];
  groups?: any[];
  orphans?: any[];
  debug?: unknown;
  imageInsights?: Record<string, ImageInsight>;
};

export type SmartDraftScanResponse = {
  status: number;
  body: SmartDraftScanBody;
};

function jsonEnvelope(status: number, body: SmartDraftScanBody): SmartDraftScanResponse {
  return { status, body };
}

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

// Phase 2: Extended RoleInfo to include category metadata
type RoleInfo = { role?: "front" | "back"; hasVisibleText?: boolean; ocr?: string; category?: string };

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

async function buildClipGroups(files: Array<{ entry: DropboxEntry; url: string }>, insightList: ImageInsight[]) {
  // CLIP-based clustering with multimodal signals: visual + text + color
  console.log(`[buildClipGroups] Clustering ${files.length} images using CLIP similarity + text/color signals`);

  // Step 1: Compute embeddings for all images (IMAGE endpoint only, no text fallback)
  const embeddings = await Promise.all(
    files.map(async (file) => {
      try {
        const emb = await clipImageEmbedding(file.url); // MUST use image endpoint only
        return emb;
      } catch (err) {
        console.warn(`[buildClipGroups] Failed to get embedding for ${file.url}:`, err);
        return null;
      }
    })
  );

  // Check if CLIP is actually working - if all embeddings are null, CLIP is unavailable
  const validEmbeddings = embeddings.filter(e => e !== null).length;
  if (validEmbeddings === 0) {
    console.warn(`[buildClipGroups] CLIP embeddings unavailable (0/${files.length} succeeded). Returning empty to fall back to vision grouping.`);
    return []; // Return empty array to signal failure - caller will use vision groups
  }

  console.log(`[buildClipGroups] Got ${validEmbeddings}/${files.length} valid CLIP embeddings`);

  // Phase C1: Log sample embeddings to verify they differ
  if (embeddings[0]) console.info("[clipVec] sample A (first 5):", embeddings[0].slice(0, 5));
  if (embeddings[1]) console.info("[clipVec] sample B (first 5):", embeddings[1].slice(0, 5));

  // Phase C2: Hash each vector to catch cache bugs
  function h5(v: number[] | null) {
    if (!v) return "null";
    let s = 0;
    for (let i = 0; i < Math.min(10, v.length); i++) s += (i + 1) * v[i];
    return s.toFixed(6);
  }
  files.forEach((file, i) => {
    const filename = file.entry.name;
    const hash = h5(embeddings[i]);
    console.info(`[clipVec] ${i} ${filename} -> ${hash}`);
  });

  // Step 1.5: Extract text and color from insights for multimodal matching
  const insightsByUrl = new Map<string, ImageInsight>();
  insightList.forEach(insight => {
    const normalized = toDirectDropbox(insight.url);
    insightsByUrl.set(normalized, insight);
    insightsByUrl.set(insight.url, insight);
  });

  const extractBrandKeywords = (text: string): Set<string> => {
    const keywords = new Set<string>();
    const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
    words.forEach(w => keywords.add(w));
    return keywords;
  };

  // Step 2: Build similarity matrix with multimodal signals
  const n = files.length;
  const similarities: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (embeddings[i] && embeddings[j]) {
        let sim = cosine(embeddings[i], embeddings[j]);

        // Multimodal boost: Adjust similarity based on text/color signals
        const insightI = insightsByUrl.get(toDirectDropbox(files[i].url));
        const insightJ = insightsByUrl.get(toDirectDropbox(files[j].url));

        if (insightI && insightJ) {
          // Text similarity boost: Extract brand/product keywords from OCR
          const textI = [insightI.ocrText, insightI.text, ...(insightI.textBlocks || [])].filter(Boolean).join(" ");
          const textJ = [insightJ.ocrText, insightJ.text, ...(insightJ.textBlocks || [])].filter(Boolean).join(" ");

          if (textI && textJ && textI.length > 10 && textJ.length > 10) {
            const keywordsI = extractBrandKeywords(textI);
            const keywordsJ = extractBrandKeywords(textJ);

            // Jaccard similarity of keywords
            const intersection = new Set([...keywordsI].filter(k => keywordsJ.has(k)));
            const union = new Set([...keywordsI, ...keywordsJ]);
            const textSim = union.size > 0 ? intersection.size / union.size : 0;

            // Boost similarity if text matches well
            if (textSim > 0.3) {
              sim = sim * 0.7 + textSim * 0.3; // Blend: 70% visual, 30% text
              console.log(`[buildClipGroups] Text boost ${files[i].entry.name} <-> ${files[j].entry.name}: visual=${cosine(embeddings[i], embeddings[j]).toFixed(3)}, text=${textSim.toFixed(3)}, final=${sim.toFixed(3)}`);
            }
          }

          // Color penalty: Different dominant colors = likely different products
          if (insightI.dominantColor && insightJ.dominantColor &&
              insightI.dominantColor !== "multi" && insightJ.dominantColor !== "multi" &&
              insightI.dominantColor !== insightJ.dominantColor) {
            sim *= 0.90; // 10% penalty for mismatched colors
            console.log(`[buildClipGroups] Color penalty ${files[i].entry.name} <-> ${files[j].entry.name}: ${insightI.dominantColor} vs ${insightJ.dominantColor}, sim reduced to ${sim.toFixed(3)}`);
          }
        }

        similarities[i][j] = sim;
        similarities[j][i] = sim;
      }
    }
  }

  // Log similarity matrix to help tune threshold
  console.log(`[buildClipGroups] Similarity matrix:`);
  for (let i = 0; i < Math.min(n, 5); i++) {
    const row = similarities[i].slice(0, 5).map(s => s.toFixed(3)).join(', ');
    console.log(`  Image ${i} (${files[i].entry.name}): [${row}${n > 5 ? ', ...' : ''}]`);
  }

  // Phase C4: Check for degenerate similarity matrix (all ~1.0)
  function isDegenerateCosineMatrix(M: number[][]): boolean {
    const n = M.length;
    let maxOff = -1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) maxOff = Math.max(maxOff, M[i][j]);
      }
    }
    return maxOff > 0.98; // almost everyone ~1.0 ⇒ bad
  }

  if (isDegenerateCosineMatrix(similarities)) {
    console.warn("[buildClipGroups] Degenerate similarity (max off-diagonal > 0.98) — embeddings are identical. Falling back to vision grouping.");
    return [];
  }

  // Step 3: Complete-linkage clustering with multimodal similarity
  // Image must have high similarity to ALL existing cluster members
  // With text/color signals, we can use a slightly lower threshold
  const SIMILARITY_THRESHOLD = 0.87; // Balanced threshold with multimodal signals
  const assigned = new Set<number>();
  const clusters: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (assigned.has(i)) continue;

    const cluster = [i];
    assigned.add(i);

    // Find all images similar to this one
    for (let j = i + 1; j < n; j++) {
      if (assigned.has(j)) continue;

      // Check if j has high similarity to ALL images in the cluster (complete-linkage)
      // This is the most conservative approach - prevents chaining
      let minSim = 1.0;
      for (const ci of cluster) {
        minSim = Math.min(minSim, similarities[ci][j]);
      }

      // Debug: Log when we're close to the threshold
      if (minSim >= 0.80 && minSim < 0.95) {
        console.log(`[buildClipGroups] Considering ${files[j].entry.name} for cluster starting with ${files[i].entry.name}: minSim=${minSim.toFixed(3)}, threshold=${SIMILARITY_THRESHOLD}`);
      }

      if (minSim >= SIMILARITY_THRESHOLD) {
        console.log(`[buildClipGroups] ✓ Added ${files[j].entry.name} to cluster (minSim=${minSim.toFixed(3)})`);
        cluster.push(j);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  console.log(`[buildClipGroups] Created ${clusters.length} clusters from ${files.length} images`);

  // Step 4: Convert clusters to groups
  const groups: any[] = clusters.map((cluster, idx) => {
    const clusterFiles = cluster.map(i => files[i]);
    const images = clusterFiles.map(f => f.url);

    const folderName = folderPath(clusterFiles[0].entry) || "";
    const baseName = (clusterFiles[0].entry.name || "").replace(/\.[^.]+$/, "").replace(/_\d+$/, "");

    return {
      groupId: `clip_${createHash("sha256").update(images.join("|")).digest("hex").substring(0, 10)}`,
      name: baseName,
      folder: folderName,
      images,
      primaryImageUrl: images[0] || null,
      secondaryImageUrl: images[1] || null,
      supportingImageUrls: images.slice(2),
    };
  });

  return groups;
}

// NEW: Trust Vision's role assignments - No CLIP overrides
async function buildHybridGroups(
  files: Array<{ entry: DropboxEntry; url: string }>,
  visionGroups: AnalyzedGroup[],
  insightList: ImageInsight[]
) {
  console.log(`[buildHybridGroups] TRUST VISION ROLES: front/back assignments are final - no CLIP overrides`);
  console.log(`[buildHybridGroups] Processing ${files.length} images, ${visionGroups.length} Vision analyses`);

  // Log what Vision identified for each image
  console.log(`[buildHybridGroups] Vision identifications:`);
  visionGroups.forEach((group, idx) => {
    // Vision groups are in same order as files array - use index-based matching
    const file = files[idx];
    const filename = file?.entry.name || 'unknown';

    // Also get the insight for this image (also by index)
    const insight = insightList[idx];
    const ocrText = (insight as any)?.textExtracted || '';
    const visualDesc = (insight as any)?.visualDescription || '';
    const role = (insight as any)?.role || 'unknown';
    const ocrPreview = ocrText ? ocrText.substring(0, 80) : '(no text)';

    console.log(`  [${idx + 1}] ${filename}: brand="${group.brand}", product="${group.product}", role="${role}", confidence=${group.confidence}`);
    console.log(`      OCR: "${ocrPreview}${ocrText.length > 80 ? '...' : ''}"`);
    if (visualDesc) {
      const visualPreview = visualDesc.substring(0, 150);
      console.log(`      Visual: "${visualPreview}${visualDesc.length > 150 ? '...' : ''}"`);
    }

    // CRITICAL CHECK: If Vision says role="front", this MUST be locked as the product front
    if (role === 'front') {
      console.log(`      ✓ LOCKED AS FRONT - Vision role assignment is final`);
    } else if (role === 'back') {
      console.log(`      ✓ LOCKED AS BACK - Vision role assignment is final`);
    }
  });

  // Step 1: Extract fronts and backs based on Vision role assignments (TRUST VISION!)
  const frontImages: Array<{
    idx: number;
    filename: string;
    url: string;
    brand: string;
    product: string;
    visionGroup: AnalyzedGroup;
    insight: ImageInsight;
  }> = [];

  const backImages: Array<{
    idx: number;
    filename: string;
    url: string;
    brand: string;
    product: string;
    visionGroup: AnalyzedGroup;
    insight: ImageInsight;
  }> = [];

  const otherImages: Array<{
    idx: number;
    filename: string;
    url: string;
    brand: string;
    product: string;
    visionGroup: AnalyzedGroup;
    insight: ImageInsight;
  }> = [];

  // Separate images by role FIRST (role is truth!)
  for (let idx = 0; idx < files.length; idx++) {
    if (idx >= visionGroups.length || idx >= insightList.length) continue;

    const file = files[idx];
    const visionGroup = visionGroups[idx];
    const insight = insightList[idx];
    const role = (insight as any)?.role || 'unknown';

    const imageData = {
      idx,
      filename: file.entry.name,
      url: file.url,
      brand: String(visionGroup.brand || 'Unknown'),
      product: String(visionGroup.product || 'Unknown'),
      visionGroup,
      insight
    };

    if (role === 'front') {
      frontImages.push(imageData);
    } else if (role === 'back') {
      backImages.push(imageData);
    } else {
      otherImages.push(imageData);
    }
  }

  console.log(`[buildHybridGroups] Role-based separation: ${frontImages.length} fronts, ${backImages.length} backs, ${otherImages.length} other`);

  // Step 2: Group fronts by brand+product (fronts become product groups)
  const productGroups = new Map<string, {
    brand: string;
    product: string;
    visionGroup: AnalyzedGroup;
    fileIndices: number[];
    fileUrls: string[];
  }>();

  const assignedIndices = new Set<number>();

  // Vision groups are in the same order as the input files array
  for (let groupIdx = 0; groupIdx < visionGroups.length; groupIdx++) {
    const visionGroup = visionGroups[groupIdx];
    const fileIdx = groupIdx; // Direct mapping: visionGroups[i] = files[i]

    if (fileIdx >= files.length) {
      console.warn(`[buildHybridGroups] Vision group index ${groupIdx} exceeds files array length ${files.length}`);
      continue;
    }

    const file = files[fileIdx];
    const filename = file.entry.name || '';

    let brand = String(visionGroup.brand || '').trim().toLowerCase();
    let product = String(visionGroup.product || '').trim().toLowerCase();

    // If Vision couldn't identify the product, try extracting brand from OCR text
    if (!brand || !product || brand === 'unknown' || product === 'unidentified item') {
      // Find the imageInsight for this file (also by index)
      const insight = insightList[fileIdx];

      if (insight && (insight as any).textExtracted) {
        const ocrText = (insight as any).textExtracted;
        console.log(`[buildHybridGroups] Vision couldn't identify ${filename}, checking OCR: "${ocrText.substring(0, 150)}..."`);

        // Try to extract brand names from OCR text
        // Common brand patterns for supplements/beauty products
        const brandPatterns = [
          /\b(R\+Co|R\s*\+\s*Co)\b/i,
          /\b(myBrainCo\.?|my\s*Brain\s*Co\.?)\b/i,
          /\b(Frog\s*Fuel)\b/i,
          /\b(Nusava)\b/i,
          /\b(BrainCo)\b/i,
        ];

        const productPatterns = [
          /\b(GUT\s*REPAIR)\b/i,
          /\b(STAY\s*UNBREAKABLE)\b/i,
          /\b(ON\s*A\s*CLOUD)\b/i,
          /\b(B12[,\s]+B6[,\s]+B1)\b/i,
        ];

        for (const pattern of brandPatterns) {
          const match = ocrText.match(pattern);
          if (match) {
            brand = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
            console.log(`[buildHybridGroups]   Found brand in OCR: "${brand}"`);

            // Try to extract product name
            for (const prodPattern of productPatterns) {
              const productMatch = ocrText.match(prodPattern);
              if (productMatch) {
                product = productMatch[1].toLowerCase().replace(/\s+/g, ' ').trim();
                console.log(`[buildHybridGroups]   Found product in OCR: "${product}"`);
                break;
              }
            }

            // If we found a brand, that might be enough
            if (brand && brand !== 'unknown') {
              // Use brand as product if no specific product found
              if (!product || product === 'unidentified item') {
                product = brand;
                console.log(`[buildHybridGroups]   Using brand as product: "${product}"`);
              }
              break;
            }
          }
        }

        if (brand && brand !== 'unknown' && product && product !== 'unidentified item') {
          console.log(`[buildHybridGroups] ✓ Extracted from OCR: brand="${brand}", product="${product}"`);
        } else {
          console.log(`[buildHybridGroups] ✗ OCR extraction failed for ${filename}`);
        }
      }

      // If still unknown, skip
      if (!brand || !product || brand === 'unknown' || product === 'unidentified item') {
        console.log(`[buildHybridGroups] Skipping non-product: brand="${brand}", product="${product}"`);
        continue;
      }
    }

    console.log(`[buildHybridGroups] Processing: ${filename} → "${brand}" "${product}"`);

    if (assignedIndices.has(fileIdx)) {
      console.warn(`[buildHybridGroups] ✗ File already assigned: ${filename}`);
      continue;
    }

    // Create product key for grouping
    const productKey = `${brand}|||${product}`;

    if (!productGroups.has(productKey)) {
      console.log(`[buildHybridGroups] ✓ New product group: "${brand}" - "${product}"`);
      productGroups.set(productKey, {
        brand: String(visionGroup.brand || brand),
        product: String(visionGroup.product || product),
        visionGroup,
        fileIndices: [],
        fileUrls: []
      });
    } else {
      console.log(`[buildHybridGroups] ✓ Adding to existing group: "${brand}" - "${product}"`);
    }

    const group = productGroups.get(productKey)!;
    group.fileIndices.push(fileIdx);
    group.fileUrls.push(file.url);
    assignedIndices.add(fileIdx);

    console.log(`[buildHybridGroups] ✓ Matched ${filename} to "${brand}" "${product}" (${group.fileUrls.length} images total)`);
  }

  console.log(`[buildHybridGroups] Created ${productGroups.size} product groups from brand+product matching`);

  // Step 2: NO CLIP VERIFICATION - Trust Vision's decisions completely
  console.log(`[buildHybridGroups] Step 2: Creating groups from Vision data (CLIP verification disabled)`);

  const hybridGroups: any[] = [];

  for (const [productKey, group] of productGroups.entries()) {
    console.log(`[buildHybridGroups] Creating group: "${group.brand}" - "${group.product}" (${group.fileUrls.length} images)`);

    // Trust Vision completely - no CLIP similarity check
    hybridGroups.push({
      ...group.visionGroup,
      images: group.fileUrls,
      indices: group.fileIndices,
      primaryImageUrl: group.fileUrls[0],
      secondaryImageUrl: group.fileUrls[1] || null,
      supportingImageUrls: group.fileUrls.slice(2)
    });
  }

  // Step 2: For unassigned images, try visual description matching
  const unassignedIndices = files
    .map((_, i) => i)
    .filter(i => !assignedIndices.has(i));

  if (unassignedIndices.length > 0) {
    console.log(`[buildHybridGroups] ${unassignedIndices.length} unassigned images - attempting visual description matching`);

    // Build descriptions of all identified product fronts
    const productDescriptions: Array<{
      brand: string;
      product: string;
      productKey: string;
      visualDescription: string;
      dominantColor: string;
      group: any;
    }> = [];

    for (const [productKey, group] of productGroups.entries()) {
      console.log(`[buildHybridGroups] Checking group "${group.brand}" - "${group.product}" (${group.fileIndices.length} images)`);
      for (const fileIdx of group.fileIndices) {
        const file = files[fileIdx];
        const filename = file.entry.name?.toLowerCase() || '';
        // Use index-based matching: insightList[i] corresponds to files[i]
        const insight = insightList[fileIdx];

        console.log(`  Checking ${filename}: insight=${!!insight}, visualDesc=${!!(insight as any)?.visualDescription}, role=${(insight as any)?.role}`);
        if (insight) {
          console.log(`    Insight URL: ${insight.url}`);
          console.log(`    Has visualDescription field: ${Object.keys(insight).includes('visualDescription')}`);
          console.log(`    visualDescription value: ${(insight as any).visualDescription?.substring(0, 50)}...`);
        }

        if (insight && (insight as any).visualDescription && (insight as any).role === 'front') {
          productDescriptions.push({
            brand: group.brand,
            product: group.product,
            productKey,
            visualDescription: (insight as any).visualDescription,
            dominantColor: (insight as any).dominantColor || 'unknown',
            group
          });
          console.log(`[buildHybridGroups] ✓ Found front for "${group.brand}" - "${group.product}"`);
          console.log(`  Visual: "${(insight as any).visualDescription}"`);
          console.log(`  Color: ${(insight as any).dominantColor}`);
        }
      }
    }

    if (productDescriptions.length > 0) {
      console.log(`[buildHybridGroups] Found ${productDescriptions.length} product front descriptions for matching`);

      // For each unassigned image, try to match by color and packaging type
      for (const unassignedIdx of unassignedIndices) {
        const file = files[unassignedIdx];
        const filename = file.entry.name?.toLowerCase() || '';
        // Use index-based matching: insightList[i] corresponds to files[i]
        const insight = insightList[unassignedIdx];

        if (!insight || !(insight as any).visualDescription) {
          console.log(`[buildHybridGroups] ${filename}: No visual description, skipping match`);
          continue;
        }

        const unassignedVisual = (insight as any).visualDescription || '';
        const unassignedColor = (insight as any).dominantColor || 'unknown';
        const unassignedRole = (insight as any).role || 'other';
        const unassignedBrand = (insight as any).brand || '';
        const unassignedProduct = (insight as any).product || '';
        const unassignedCategory = (insight as any).categoryPath || '';

        console.log(`[buildHybridGroups] Trying to match ${filename}:`);
        console.log(`  Visual: "${unassignedVisual}"`);
        console.log(`  Color: ${unassignedColor}`);
        console.log(`  Role: ${unassignedRole}`);
        console.log(`  Brand: ${unassignedBrand}, Category: ${unassignedCategory}`);

        // Try to match using ALL available visual details
        const visualLower = unassignedVisual.toLowerCase();
        let bestMatch: typeof productDescriptions[0] | null = null;
        let matchReason = '';

        for (const product of productDescriptions) {
          const productVisualLower = product.visualDescription.toLowerCase();
          let score = 0;
          const reasons: string[] = [];

          // GUARDRAILS: Check category compatibility first
          const targetGroup = product.group;
          const targetCategory = targetGroup?.categoryPath || '';
          const catCompat = categoryCompat(unassignedCategory, targetCategory);
          
          // Hard block: cross-category mismatches (hair vs supplement/food)
          if (catCompat <= -0.5) {
            console.log(`  ✗ Blocked ${product.brand} - ${product.product}: category mismatch (hair↔supp/food)`);
            continue;
          }

          // GUARDRAILS: Check brand compatibility
          const unassignedBrandNorm = normBrand(unassignedBrand);
          const targetBrandNorm = normBrand(product.brand);
          const brandMatch = !!(unassignedBrandNorm && targetBrandNorm && unassignedBrandNorm === targetBrandNorm);
          
          // GUARDRAILS: Check product token similarity
          const unassignedProdTokens = tokenize(unassignedProduct);
          const targetProdTokens = tokenize(product.product);
          const prodSim = jaccard(unassignedProdTokens, targetProdTokens);

          // Add brand/category/product to score
          if (brandMatch) {
            score += 20;  // Strong brand match
            reasons.push(`brand=${unassignedBrandNorm}`);
          }
          if (catCompat >= 0.6) {
            score += 10;  // Same category
            reasons.push(`category-match`);
          } else if (catCompat >= 0.2) {
            score += 2;   // Compatible category
            reasons.push(`category-compat`);
          }
          if (prodSim >= 0.6) {
            score += 15;  // Strong product similarity
            reasons.push(`product-sim=${prodSim.toFixed(2)}`);
          } else if (prodSim >= 0.4) {
            score += 5;   // Moderate product similarity
            reasons.push(`product-sim=${prodSim.toFixed(2)}`);
          }

          // 1. DOMINANT COLOR MATCH (highest priority - 15 points)
          if (product.dominantColor === unassignedColor) {
            score += 15;
            reasons.push(`color=${unassignedColor}`);
          }

          // 2. PACKAGING TYPE MATCH (very important - 10 points)
          const packagingTypes = [
            'pouch', 'stand-up pouch', 'resealable pouch',
            'bottle', 'plastic bottle', 'glass bottle', 'cylindrical bottle',
            'jar', 'tube', 'squeeze tube', 'pump bottle',
            'box', 'rectangular box', 'canister', 'container'
          ];
          let foundPackaging = false;
          for (const pkg of packagingTypes) {
            if (visualLower.includes(pkg) && productVisualLower.includes(pkg)) {
              score += 10;
              reasons.push(`packaging=${pkg}`);
              foundPackaging = true;
              break;
            }
          }

          // 3. MATERIAL/FINISH MATCH (important - 5 points)
          const materials = [
            'glossy', 'matte', 'metallic', 'foil',
            'transparent', 'clear', 'frosted',
            'plastic', 'glass', 'paper'
          ];
          for (const material of materials) {
            if (visualLower.includes(material) && productVisualLower.includes(material)) {
              score += 5;
              reasons.push(`material=${material}`);
              break;
            }
          }

          // 4. SHAPE DESCRIPTORS (medium - 5 points)
          const shapes = [
            'cylindrical', 'rectangular', 'square', 'oval',
            'tall and narrow', 'short and wide', 'flat',
            'rounded corners', 'bulging'
          ];
          for (const shape of shapes) {
            if (visualLower.includes(shape) && productVisualLower.includes(shape)) {
              score += 5;
              reasons.push(`shape=${shape}`);
              break;
            }
          }

          // 5. TEXT COLOR MATCH (helpful - 3 points each, max 6)
          const textColors = ['white text', 'black text', 'silver text', 'gold text', 'colored text'];
          let textColorPoints = 0;
          for (const textColor of textColors) {
            if (visualLower.includes(textColor) && productVisualLower.includes(textColor)) {
              textColorPoints += 3;
              reasons.push(`text=${textColor}`);
              if (textColorPoints >= 6) break;
            }
          }
          score += textColorPoints;

          // 6. TEXT LAYOUT MATCH (helpful - 4 points)
          const layouts = [
            'vertical text', 'horizontal text', 'diagonal',
            'text in center', 'text at top', 'text at bottom',
            'text in panels', 'text in sections'
          ];
          for (const layout of layouts) {
            if (visualLower.includes(layout) && productVisualLower.includes(layout)) {
              score += 4;
              reasons.push(`layout=${layout}`);
              break;
            }
          }

          // 7. SPECIFIC PANELS/SECTIONS (confirms it's product back - 3 points each)
          const backFeatures = [
            'supplement facts', 'nutrition facts', 'nutrition panel',
            'ingredient list', 'ingredients section',
            'directions', 'directions panel',
            'barcode', 'upc code',
            'warnings', 'allergen', 'storage instructions'
          ];
          let panelPoints = 0;
          for (const feature of backFeatures) {
            if (visualLower.includes(feature)) {
              panelPoints += 3;
              reasons.push(`has-${feature}`);
            }
          }
          score += Math.min(panelPoints, 9); // Max 9 points from panels

          // 8. SPECIAL FEATURES MATCH (nice to have - 2 points)
          const specialFeatures = [
            'tear notch', 'zip lock', 'resealable', 'tamper seal',
            'embossed', 'holographic', 'foil accent',
            'transparent window', 'hanging hole'
          ];
          for (const feature of specialFeatures) {
            if (visualLower.includes(feature) && productVisualLower.includes(feature)) {
              score += 2;
              reasons.push(`feature=${feature}`);
              break;
            }
          }

          // 9. SIZE INDICATORS (helpful - 2 points)
          const sizeIndicators = ['large', 'small', 'medium', 'tall', 'short', 'wide', 'narrow'];
          for (const size of sizeIndicators) {
            if (visualLower.includes(size) && productVisualLower.includes(size)) {
              score += 2;
              reasons.push(`size=${size}`);
              break;
            }
          }

          if (score > 0 && (!bestMatch || score > (bestMatch as any)._score)) {
            bestMatch = product;
            (bestMatch as any)._score = score;
            (bestMatch as any)._brandMatch = brandMatch;
            (bestMatch as any)._prodSim = prodSim;
            (bestMatch as any)._catCompat = catCompat;
            matchReason = reasons.join(', ');
          }
        }

        // GUARDRAILS: Final check before accepting match
        if (bestMatch && (bestMatch as any)._score >= 20) {
          const finalScore = (bestMatch as any)._score;
          const finalBrandMatch = (bestMatch as any)._brandMatch;
          const finalProdSim = (bestMatch as any)._prodSim || 0;
          const finalCatCompat = (bestMatch as any)._catCompat || 0;
          
          // Hard block: category mismatch (should already be filtered, but double-check)
          const catBlock = finalCatCompat <= -0.5;
          
          // Weak match: not enough evidence to be confident
          const weak = finalScore < 40 && !(finalBrandMatch && finalProdSim >= 0.6);
          
          if (catBlock) {
            console.log(`[buildHybridGroups] ✗ BLOCKED ${filename}: category incompatible (${finalCatCompat.toFixed(2)})`);
            continue;
          }
          
          if (weak) {
            console.log(`[buildHybridGroups] ✗ BLOCKED ${filename}: weak match (score=${finalScore}, brand=${finalBrandMatch}, prodSim=${finalProdSim.toFixed(2)})`);
            continue;
          }

          console.log(`[buildHybridGroups] ✓ Matched ${filename} to "${bestMatch.brand}" - "${bestMatch.product}"`);
          console.log(`  Match score: ${finalScore}, reasons: ${matchReason}`);

          bestMatch.group.fileIndices.push(unassignedIdx);
          bestMatch.group.fileUrls.push(file.url);
          assignedIndices.add(unassignedIdx);

          // Update the hybrid group that was already created
          const existingGroup = hybridGroups.find(hg =>
            hg.brand === bestMatch!.brand && hg.product === bestMatch!.product
          );
          if (existingGroup) {
            existingGroup.images.push(file.url);
            existingGroup.indices.push(unassignedIdx);
            if (!existingGroup.secondaryImageUrl) {
              existingGroup.secondaryImageUrl = file.url;
            } else {
              existingGroup.supportingImageUrls = existingGroup.supportingImageUrls || [];
              existingGroup.supportingImageUrls.push(file.url);
            }
            console.log(`  Updated group to ${existingGroup.images.length} images`);
          }
        } else {
          const scoreInfo = bestMatch ? `(best score: ${(bestMatch as any)._score})` : '(no matches found)';
          console.log(`[buildHybridGroups] ✗ ${filename}: No confident match ${scoreInfo}`);
        }
      }
    } else {
      console.log(`[buildHybridGroups] No product front descriptions available for matching`);
    }
  }

  // Step 3: Try to merge orphan back-only groups with matching front groups
  console.log(`[buildHybridGroups] Step 3: Checking for orphan back-only groups to merge...`);
  const groupsToRemove: string[] = [];

  for (let i = 0; i < hybridGroups.length; i++) {
    const backGroup = hybridGroups[i];

    // Skip if not a single-image back-only group from same brand
    if (backGroup.images.length !== 1) continue;
    const backIdx = files.findIndex(f => f.url === backGroup.images[0]);
    if (backIdx === -1) continue;
    // Use index-based matching: insightList[i] corresponds to files[i]
    const backInsight = insightList[backIdx];
    if (!backInsight?.role || backInsight.role !== 'back') continue;
    if (!backInsight.visualDescription) continue;

    const backVisual = backInsight.visualDescription.toLowerCase();
    const backColor = (backInsight.dominantColor || '').toLowerCase();
    const backBrand = (backInsight as any).brand || '';
    const backProduct = (backInsight as any).product || '';
    const backCategory = (backInsight as any).categoryPath || '';

    console.log(`[buildHybridGroups]   Checking orphan back: ${files[backIdx].entry.name} (${backGroup.brand})`);
    console.log(`    Back category: ${backCategory}`);

    // Look for a front group from the same brand
    let bestFrontGroup: typeof hybridGroups[0] | null = null;
    let bestScore = 0;
    let bestCatCompat = 0;
    let bestBrandMatch = false;
    let bestProdSim = 0;

    for (let j = 0; j < hybridGroups.length; j++) {
      if (i === j) continue;
      const frontGroup = hybridGroups[j];

      // GUARDRAILS: Check category compatibility first
      const frontCategory = frontGroup.categoryPath || '';
      const catCompat = categoryCompat(backCategory, frontCategory);
      
      // Hard block: cross-category mismatches (hair vs supplement/food)
      if (catCompat <= -0.5) {
        console.log(`    ✗ Skip ${frontGroup.brand}: category mismatch (${catCompat.toFixed(2)})`);
        continue;
      }

      // Must be same brand
      if (frontGroup.brand?.toLowerCase() !== backGroup.brand?.toLowerCase()) continue;

      // GUARDRAILS: Check brand and product similarity
      const frontBrandNorm = normBrand(frontGroup.brand);
      const backBrandNorm = normBrand(backBrand);
      const brandMatch = !!(frontBrandNorm && backBrandNorm && frontBrandNorm === backBrandNorm);
      
      const frontProdTokens = tokenize(frontGroup.product || frontGroup.name || '');
      const backProdTokens = tokenize(backProduct);
      const prodSim = jaccard(frontProdTokens, backProdTokens);

      // Find the front image in this group
      const frontIdx = frontGroup.images.findIndex((url: string) => {
        const idx = files.findIndex(f => f.url === url);
        if (idx === -1) return false;
        // Use index-based matching: insightList[i] corresponds to files[i]
        const insight = insightList[idx];
        return insight?.role === 'front';
      });

      if (frontIdx === -1) continue;

      const frontUrl = frontGroup.images[frontIdx];
      const frontFileIdx = files.findIndex(f => f.url === frontUrl);
      // Use index-based matching: insightList[i] corresponds to files[i]
      const frontInsight = insightList[frontFileIdx];

      if (!frontInsight?.visualDescription) continue;

      const frontVisual = frontInsight.visualDescription.toLowerCase();
      const frontColor = (frontInsight.dominantColor || '').toLowerCase();

      let score = 0;

      // GUARDRAILS: Add brand/category/product to score
      if (brandMatch) {
        score += 20;  // Strong brand match
      }
      if (catCompat >= 0.6) {
        score += 10;  // Same category
      } else if (catCompat >= 0.2) {
        score += 2;   // Compatible category
      }
      if (prodSim >= 0.6) {
        score += 15;  // Strong product similarity
      } else if (prodSim >= 0.4) {
        score += 5;   // Moderate product similarity
      }

      // Use the same enhanced scoring system
      // 1. Color match (15 points)
      if (backColor && frontColor && backColor === frontColor) {
        score += 15;
      }

      // 2. Packaging type match (10 points)
      const packagingTypes = [
        'pouch', 'stand-up pouch', 'resealable pouch',
        'bottle', 'plastic bottle', 'glass bottle', 'cylindrical bottle',
        'jar', 'tube', 'squeeze tube', 'pump bottle',
        'box', 'rectangular box', 'canister', 'container'
      ];
      for (const pkg of packagingTypes) {
        if (backVisual.includes(pkg) && frontVisual.includes(pkg)) {
          score += 10;
          break;
        }
      }

      // 3. Material match (5 points)
      const materials = [
        'glossy', 'matte', 'metallic', 'foil',
        'transparent', 'clear', 'frosted',
        'plastic', 'glass', 'paper'
      ];
      for (const material of materials) {
        if (backVisual.includes(material) && frontVisual.includes(material)) {
          score += 5;
          break;
        }
      }

      // 4. Shape match (5 points)
      const shapes = [
        'cylindrical', 'rectangular', 'square', 'oval',
        'tall and narrow', 'short and wide', 'flat',
        'rounded corners', 'bulging'
      ];
      for (const shape of shapes) {
        if (backVisual.includes(shape) && frontVisual.includes(shape)) {
          score += 5;
          break;
        }
      }

      // 5. Text color match (3 points)
      const textColors = ['white text', 'black text', 'silver text', 'gold text'];
      for (const textColor of textColors) {
        if (backVisual.includes(textColor) && frontVisual.includes(textColor)) {
          score += 3;
          break;
        }
      }

      // 6. Special features (2 points)
      const specialFeatures = [
        'tear notch', 'zip lock', 'resealable', 'tamper seal',
        'embossed', 'holographic', 'foil accent'
      ];
      for (const feature of specialFeatures) {
        if (backVisual.includes(feature) && frontVisual.includes(feature)) {
          score += 2;
          break;
        }
      }
      for (const pkg of packagingTypes) {
        if (backVisual.includes(pkg) && frontVisual.includes(pkg)) {
          score += 5;
          break;
        }
      }

      // Material match (old code, remove this section)

      if (score > bestScore) {
        bestScore = score;
        bestFrontGroup = frontGroup;
        bestCatCompat = catCompat;
        bestBrandMatch = brandMatch;
        bestProdSim = prodSim;
      }
    }

    // GUARDRAILS: Final check before merging
    if (bestFrontGroup && bestScore >= 20) {
      // Hard block: category mismatch (should already be filtered, but double-check)
      const catBlock = bestCatCompat <= -0.5;
      
      // Weak match: not enough evidence to be confident
      const weak = bestScore < 40 && !(bestBrandMatch && bestProdSim >= 0.6);
      
      if (catBlock) {
        console.log(`[buildHybridGroups]   ✗ BLOCKED: category incompatible (${bestCatCompat.toFixed(2)})`);
        continue;
      }
      
      if (weak) {
        console.log(`[buildHybridGroups]   ✗ BLOCKED: weak match (score=${bestScore}, brand=${bestBrandMatch}, prodSim=${bestProdSim.toFixed(2)})`);
        continue;
      }

      console.log(`[buildHybridGroups]   ✓ Merging "${backGroup.name}" back into "${bestFrontGroup.name}" (score: ${bestScore})`);

      // Add back image to front group
      bestFrontGroup.images.push(backGroup.images[0]);
      if (!bestFrontGroup.secondaryImageUrl) {
        bestFrontGroup.secondaryImageUrl = backGroup.images[0];
      } else {
        bestFrontGroup.supportingImageUrls = bestFrontGroup.supportingImageUrls || [];
        bestFrontGroup.supportingImageUrls.push(backGroup.images[0]);
      }

      // Mark back group for removal
      groupsToRemove.push(backGroup.groupId);
      assignedIndices.add(backIdx);
    } else {
      console.log(`[buildHybridGroups]   ✗ No match found for orphan back (best score: ${bestScore})`);
    }
  }

  // Remove merged groups
  if (groupsToRemove.length > 0) {
    console.log(`[buildHybridGroups]   Removing ${groupsToRemove.length} merged groups`);
    for (let i = hybridGroups.length - 1; i >= 0; i--) {
      if (groupsToRemove.includes(hybridGroups[i].groupId)) {
        hybridGroups.splice(i, 1);
      }
    }
  }

  // Step 4: Create "Uncategorized" group for remaining unassigned images
  const finalUnassigned = files
    .map((_, i) => i)
    .filter(i => !assignedIndices.has(i));

  if (finalUnassigned.length > 0) {
    const uncategorizedImages = finalUnassigned.map(i => files[i].url);
    console.log(`[buildHybridGroups] Created Uncategorized group with ${uncategorizedImages.length} images:`,
      finalUnassigned.map(i => files[i].entry.name));

    hybridGroups.push({
      groupId: "uncategorized",
      name: "Uncategorized",
      brand: null,
      product: "Uncategorized Items",
      images: uncategorizedImages,
      primaryImageUrl: uncategorizedImages[0],
      secondaryImageUrl: null,
      supportingImageUrls: uncategorizedImages.slice(1),
      confidence: 0,
    });
  }

  console.log(`[buildHybridGroups] Final: ${hybridGroups.length} groups (${visionGroups.length} Vision products + ${finalUnassigned.length > 0 ? 1 : 0} uncategorized)`);
  return hybridGroups;
}

function buildPairwiseGroups(files: Array<{ entry: DropboxEntry; url: string }>, insightList: ImageInsight[]) {
  // Simple strategy: Pair images sequentially by filename (timestamps)
  // Works best when user takes photos in order: front, back, front, back, etc.

  const sorted = files.slice().sort((a, b) => (a.entry.name || "").localeCompare(b.entry.name || ""));
  const groups: any[] = [];

  console.log(`[buildPairwiseGroups] DEBUG: Pairing ${files.length} images sequentially`);

  // Pair every 2 consecutive images
  for (let i = 0; i < sorted.length; i += 2) {
    const img1 = sorted[i];
    const img2 = sorted[i + 1];

    if (!img1) break;

    const images: string[] = [img1.url];
    if (img2) images.push(img2.url);

    const folderName = folderPath(img1.entry) || "";
    const baseName = (img1.entry.name || "").replace(/\.[^.]+$/, "").replace(/_\d+$/, "");

    groups.push({
      groupId: `pair_${createHash("sha1").update(images.join("|")).digest("hex").slice(0, 10)}`,
      name: baseName || `Product ${Math.floor(i / 2) + 1}`,
      folder: folderName,
      images,
      primaryImageUrl: img1.url,
      secondaryImageUrl: img2?.url || null,
      brand: undefined,
      product: baseName || `Product ${Math.floor(i / 2) + 1}`,
      variant: undefined,
      size: undefined,
      claims: [],
      confidence: 0.5,
      _pairwise: true,
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

export async function runSmartDraftScan(options: SmartDraftScanOptions): Promise<SmartDraftScanResponse> {
  const folder = typeof options.folder === "string" ? options.folder.trim() : "";
  const force = Boolean(options.force);
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_IMAGES) : MAX_IMAGES;
  const debugRaw = options.debug;
  const debugEnabled = typeof debugRaw === "string"
    ? ["1", "true", "yes", "debug"].includes(debugRaw.toLowerCase())
    : Boolean(debugRaw);
  const userId = options.userId;
  const skipQuota = Boolean(options.skipQuota);

  if (!folder) {
    return { status: 400, body: { ok: false, error: "Provide folder path" } };
  }

  try {
    const store = tokensStore();
  const saved = (await store.get(userScopedKey(userId, "dropbox.json"), { type: "json" })) as any;
    const refresh = typeof saved?.refresh_token === "string" ? saved.refresh_token.trim() : "";
    if (!refresh) {
  return jsonEnvelope(400, { ok: false, error: "Connect Dropbox first" });
    }

    const access = await dropboxAccessToken(refresh);
    const files = (await listFolder(access, folder)).sort((a, b) => (a.path_lower || "").localeCompare(b.path_lower || ""));
    if (!files.length) {
      return jsonEnvelope(200, {
        ok: true,
        folder,
        signature: null,
        count: 0,
        warnings: ["No images found in folder."],
        groups: [],
        imageInsights: {},
      });
    }

    const limitedFiles = files.slice(0, limit);
    const signature = makeSignature(limitedFiles);
    const cacheKey = makeCacheKey(userId, folder);
    const cached = await getCachedSmartDraftGroups(cacheKey);
    if (!force && !debugEnabled && cached && cached.signature === signature && Array.isArray(cached.groups) && cached.groups.length) {
      return jsonEnvelope(200, {
        ok: true,
        cached: true,
        folder,
        signature,
        count: cached.groups.length,
        warnings: cached.warnings || [],
        groups: hydrateGroups(cached.groups, folder),
        imageInsights:
          cached.imageInsights && typeof cached.imageInsights === "object"
            ? cached.imageInsights
            : {},
      });
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

    // Build maps for displayUrl hydration: key -> https URL
    const httpsByKey = new Map<string, string>();   // key -> https URL
    const originalByKey = new Map<string, string>(); // key -> original request URL
    
    for (const tuple of fileTuples) {
      const k = urlKey(tuple.url);
      originalByKey.set(k, tuple.url);
      if (/^https?:\/\//i.test(tuple.url)) {
        httpsByKey.set(k, tuple.url);
      }
    }

    const urls = sanitizeUrls(fileTuples.map((tuple) => tuple.url));
    const analysisMeta = fileTuples.map((tuple) => ({
      url: tuple.url,
      name: tuple.entry?.name || "",
      folder: folderPath(tuple.entry) || folder,
    }));
    if (!urls.length) {
      const fallbackGroups = buildFallbackGroups(fileTuples);
      return jsonEnvelope(200, {
        ok: true,
        folder,
        signature,
        count: fallbackGroups.length,
        warnings: ["No usable image URLs; generated fallback groups."],
        groups: hydrateGroups(fallbackGroups, folder),
        orphans: hydrateOrphans(fileTuples, folder),
        imageInsights: {},
      });
    }

    if (!debugEnabled) {
  const allowed = skipQuota ? true : await canConsumeImages(userId, urls.length);
      if (!allowed) {
  return jsonEnvelope(429, { ok: false, error: "Daily image quota exceeded" });
      }
      if (!skipQuota) {
        await consumeImages(userId, urls.length);
      }
    }

    const analysis = await runAnalysis(urls, 12, {
      skipPricing: true,
      metadata: analysisMeta,
      debugVisionResponse: debugEnabled,
      force,
    });
  const insightMap = new Map<string, ImageInsight>();
  const insightByBase = new Map<string, ImageInsight>();
  const roleByBase = new Map<string, RoleInfo>();
    const rawInsights = analysis?.imageInsights || {};

    // When USE_NEW_SORTER is enabled, use raw vision insights to avoid corruption from old logic
    let insightList: ImageInsight[] = USE_NEW_SORTER && Array.isArray(analysis?._rawVisionInsights)
      ? (analysis._rawVisionInsights as ImageInsight[])
      : Array.isArray(rawInsights)
      ? (rawInsights as ImageInsight[])
      : Object.entries(rawInsights)
          .map(([url, insight]) => {
            if (!insight) return null;
            return { ...(insight as ImageInsight), url };
          })
          .filter((value): value is ImageInsight => Boolean(value));

    // Sanitize insight URLs immediately - replace placeholders like "<imgUrl>" with original URLs
    // And add key + displayUrl fields for client rendering
    insightList = insightList.map((insight, idx) => {
      const originalUrl = urls[idx] || fileTuples[idx]?.url || '';
      const sanitizedUrl = sanitizeInsightUrl(insight.url, originalUrl);
      const key = urlKey(sanitizedUrl);
      
      // Harvest https URLs for displayUrl hydration
      if (/^https?:\/\//i.test(sanitizedUrl)) {
        httpsByKey.set(key, sanitizedUrl);
      }
      
      // Use the original URL for displayUrl (it's a real Dropbox URL)
      // This ensures thumbnails can load even if sanitizedUrl is a basename
      const displayUrl = makeDisplayUrl(originalUrl, key);
      
      return { 
        ...insight, 
        url: sanitizedUrl,
        key,
        displayUrl
      };
    });

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
      
      // Ensure key and displayUrl are set
      const key = (insight as any).key || urlKey(normalizedUrl);
      const displayUrl = (insight as any).displayUrl || normalizedUrl;
      
      const payload: ImageInsight = { 
        ...insight, 
        url: normalizedUrl,
        key,
        displayUrl
      } as any;
      
      // Use key for consistent indexing (already has prefix stripped)
      if (!insightMap.has(key)) {
        insightMap.set(key, payload);
      }
      
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
        // Phase 2: Include category from vision/LLM if available
        const categoryRaw = (payload as any).category || (payload as any).categoryPath;
        if (typeof categoryRaw === "string" && categoryRaw.trim()) {
          info.category = categoryRaw.trim();
        }
        if (info.role || info.hasVisibleText !== undefined || info.ocr || info.category) {
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
          // Index by urlKey of tuple.url to avoid duplicates
          const key = urlKey(tuple.url);
          if (!insightMap.has(key)) {
            insightMap.set(key, match);
          }
          if (!roleByBase.has(base)) {
            const roleRaw = typeof match.role === "string" ? match.role.toLowerCase().trim() : "";
            const info: RoleInfo = {};
            if (roleRaw === "front" || roleRaw === "back") info.role = roleRaw;
            if (typeof match.hasVisibleText === "boolean") info.hasVisibleText = match.hasVisibleText;
            const ocrText = extractInsightOcr(match);
            if (ocrText) info.ocr = ocrText;
            // Phase 2: Include category from vision/LLM if available
            const categoryRaw = (match as any).category || (match as any).categoryPath;
            if (typeof categoryRaw === "string" && categoryRaw.trim()) {
              info.category = categoryRaw.trim();
            }
            if (info.role || info.hasVisibleText !== undefined || info.ocr || info.category) roleByBase.set(base, info);
          }
          break;
        }
      }
    }

    // Phase 3: Debug log role lookups for the batch
    if (debugEnabled && roleByBase.size > 0) {
      console.log(`[smartdrafts-scan] Phase 3: Role index built (${roleByBase.size} files)`);
      const roleSamples: Array<{ file: string; role: string | null; hasText: boolean; ocrLength: number }> = [];
      for (const [base, info] of roleByBase.entries()) {
        roleSamples.push({
          file: base,
          role: info.role || null,
          hasText: info.hasVisibleText ?? false,
          ocrLength: info.ocr?.length || 0,
        });
      }
      // Show first 10 entries
      console.log("[smartdrafts-scan] Role lookup samples:", JSON.stringify(roleSamples.slice(0, 10), null, 2));
    }

    // Phase 5: Handle dummy/missing-insight images - add dummy insights for any URL without one
    for (const tuple of fileTuples) {
      const b = basenameFrom(tuple.url).toLowerCase();
      if (!roleByBase.has(b)) {
        roleByBase.set(b, { role: undefined, hasVisibleText: false, ocr: "" });
      }
    }
    if (debugEnabled) {
      console.log(`[smartdrafts-scan] Phase 5: Role index after dummy fill (${roleByBase.size} files)`);
    }

    const roleInfoFor = (value: string | null | undefined): RoleInfo | undefined => {
      if (!value) return undefined;
      const base = basenameFrom(value).toLowerCase();
      if (!base) return undefined;
      return roleByBase.get(base);
    };

    const ensureInsightEntry = (value: string | null | undefined): ImageInsight | undefined => {
      if (!value) return undefined;
      const normalized = toDirectDropbox(value);
      let insight = insightMap.get(normalized) || insightMap.get(value);
      if (insight) {
        if (!insightMap.has(normalized)) insightMap.set(normalized, insight);
      } else {
        insight = { url: normalized };
        insightMap.set(normalized, insight);
      }
      const base = basenameFrom(normalized).toLowerCase();
      if (base && !insightByBase.has(base)) {
        insightByBase.set(base, insight);
      }
      return insight;
    };

    const assignRoleInfo = (value: string | null | undefined, patch: RoleInfo) => {
      if (!value) return;
      const base = basenameFrom(value).toLowerCase();
      if (!base) return;
      const existing = roleByBase.get(base) || {};
      const updated: RoleInfo = { ...existing };
      if (patch.role && !updated.role) updated.role = patch.role;
      if (patch.hasVisibleText !== undefined && updated.hasVisibleText === undefined) {
        updated.hasVisibleText = patch.hasVisibleText;
      }
      if (patch.ocr && (!updated.ocr || updated.ocr.length < patch.ocr.length)) {
        updated.ocr = patch.ocr;
      }
      roleByBase.set(base, updated);
    };

    const insightForUrl = (value: string | null | undefined): ImageInsight | undefined => {
      if (!value) return undefined;
      const normalized = toDirectDropbox(value);
      return insightMap.get(normalized) || insightMap.get(value) || insightByBase.get(basenameFrom(value).toLowerCase());
    };

    // Phase R0: Hybrid approach - Use Vision product IDs + CLIP similarity matching
    console.log(`[Phase R0] Starting - USE_NEW_SORTER=${USE_NEW_SORTER}, USE_CLIP=${USE_CLIP}, fileTuples=${fileTuples.length}, insightList=${insightList.length}`);
    
    if (!USE_CLIP) {
      console.log('[Phase R0] CLIP verification disabled; using vision-only roles and grouping');
    }
    
    let groups: AnalyzedGroup[];
    if (USE_NEW_SORTER) {
      // NEW HYBRID APPROACH: Trust Vision's product identification, use CLIP for image matching
      const visionGroups = Array.isArray(analysis?.groups) ? (analysis.groups as AnalyzedGroup[]) : [];
      
      // Sanitize all URLs in vision groups immediately
      visionGroups.forEach((g, idx) => {
        const originalUrl = urls[idx] || fileTuples[idx]?.url || '';
        if (g.primaryImageUrl) {
          g.primaryImageUrl = sanitizeInsightUrl(g.primaryImageUrl, originalUrl);
        }
        if (g.heroUrl) {
          g.heroUrl = sanitizeInsightUrl(g.heroUrl, originalUrl);
        }
        if (g.backUrl) {
          g.backUrl = sanitizeInsightUrl(g.backUrl, originalUrl);
        }
        if (Array.isArray(g.images)) {
          g.images = g.images.map(img => sanitizeInsightUrl(img, originalUrl));
        }
      });

      console.log(`[Phase R0] DEBUG: visionGroups structure:`, JSON.stringify(visionGroups.map(g => ({
        groupId: g.groupId,
        brand: g.brand,
        product: g.product,
        hasImages: !!g.images,
        imagesCount: g.images?.length || 0,
        imagesSample: g.images?.slice(0, 2)
      })), null, 2));

      // Harvest https URLs from visionGroups for displayUrl hydration
      for (const vg of visionGroups) {
        const images = vg.images || [];
        for (const img of images) {
          if (typeof img === 'string' && /^https?:\/\//i.test(img)) {
            const k = urlKey(img);
            if (!httpsByKey.has(k)) {
              httpsByKey.set(k, img);
            }
          }
        }
      }
      
      console.log(`[displayUrl] Harvested ${httpsByKey.size} https URLs for display`);

      if (visionGroups.length > 0) {
        if (USE_CLIP) {
          console.log(`[Phase R0] Using hybrid approach: Vision product IDs + CLIP similarity matching`);
          groups = await buildHybridGroups(fileTuples, visionGroups, insightList);

          if (debugEnabled) {
            console.log(`[Phase R0] Created ${groups.length} hybrid groups from ${fileTuples.length} images`);
          }
        } else {
          console.log(`[Phase R0] CLIP disabled - using vision-only grouping`);
          groups = visionGroups;
        }
      } else {
        // Fallback to pure CLIP if Vision returned nothing (only if CLIP enabled)
        if (USE_CLIP) {
          groups = await buildClipGroups(fileTuples, insightList);
          if (debugEnabled) {
            console.log(`[Phase R0] Vision unavailable, using ${groups.length} CLIP-based groups`);
          }
        } else {
          console.log(`[Phase R0] Vision unavailable and CLIP disabled - no groups created`);
          groups = [];
        }
      }

      // If both failed (returned empty), fall back to vision groups as-is
      if (!groups.length && visionGroups.length > 0) {
        groups = visionGroups;
        if (debugEnabled) {
          console.log(`[Phase R0] Hybrid/CLIP unavailable, falling back to ${visionGroups.length} vision groups`);
        }
      }
    } else {
      groups = Array.isArray(analysis?.groups)
        ? (analysis.groups as AnalyzedGroup[])
        : [];
    }
    let warnings: string[] = Array.isArray(analysis?.warnings) ? analysis.warnings : [];

    if (!groups.length) {
      const fallback = buildFallbackGroups(fileTuples);
      groups = fallback;
      warnings = [...warnings, "Vision grouping returned no results; falling back to folder grouping."];
    }

    const debugCandidatesPerGroup = debugEnabled ? groups.map(() => [] as DebugCandidate[]) : null;

    // Phase 1: Stop seeding from vision.groups[].images to prevent cross-pollution
    const desiredByGroup: string[][] = groups.map(() => []);

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

  // PHASE 1: HARD GATES & TUNABLES
  const FOLDER_GATE = (process.env.FOLDER_GATE ?? "true") === "true";
  const CATEGORY_GATE = (process.env.CATEGORY_GATE ?? "true") === "true";
  const BRAND_GATE = (process.env.BRAND_GATE ?? "true") === "true";
  const OUTLIER_GATE = (process.env.OUTLIER_GATE ?? "true") === "true";

  // PHASE 1: THRESHOLDS
  const OCR_BRAND_MIN_RAW = Number(process.env.OCR_BRAND_MIN ?? 1);
  const OCR_BRAND_MIN = Number.isFinite(OCR_BRAND_MIN_RAW) ? OCR_BRAND_MIN_RAW : 1;
  const OUTLIER_MIN_SIM_RAW = Number(process.env.OUTLIER_MIN_SIM ?? 0.35);
  const OUTLIER_MIN_SIM = Number.isFinite(OUTLIER_MIN_SIM_RAW) ? OUTLIER_MIN_SIM_RAW : 0.35;
  // Note: CLIP_MIN_SIM and BACK_MIN_SIM already defined above

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
      // CLIP disabled - return null immediately
      if (!USE_CLIP) {
        return Promise.resolve(null);
      }
      
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

    // Helper for new sorter
    const getOCRForUrl = async (url: string): Promise<string> => {
      const insight = insightMap.get(url);
      if (insight?.ocrText) return insight.ocrText;
      const parts: string[] = [];
      if ((insight as any)?.textBlocks) parts.push(...(insight as any).textBlocks);
      return parts.join(" ").trim();
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
        const baseInsight = ensureInsightEntry(url) as any;
        const textParts: string[] = [];
        if (typeof baseInsight?.ocrText === "string") textParts.push(baseInsight.ocrText);
        if (Array.isArray(baseInsight?.textBlocks)) textParts.push(baseInsight.textBlocks.join(" "));
        if (baseInsight?.role) textParts.push(String(baseInsight.role));
        if (baseInsight?.hasVisibleText) textParts.push("visible text");
        const groupedText = collectGroupTextForImage(group, url);
        if (groupedText.length) textParts.push(groupedText.join(" "));
        const combinedText = textParts.join(" ").trim();
        if (combinedText && baseInsight) {
          if (!baseInsight.ocrText) baseInsight.ocrText = combinedText;
          if (baseInsight.hasVisibleText === undefined) baseInsight.hasVisibleText = true;
        }
        if (combinedText) {
          assignRoleInfo(url, { hasVisibleText: true, ocr: combinedText });
        }
        const detail: CandidateDetail = {
          url,
          name,
          folder: entry ? folderPath(entry) || folder : folder,
          order: urlOrder.has(url) ? urlOrder.get(url)! : Number.MAX_SAFE_INTEGER,
          ocrText: combinedText,
        };
        if (combinedText) detail._hasText = true;
        return detail;
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

      // Phase 6: Folder gate - only consider images from this group's folder
      let groupCandidates = folderKey
        ? candidateDetails.filter((candidate) => normalizeFolderKey(candidate.folder) === folderKey)
        : candidateDetails.slice();
      if (!groupCandidates.length) {
        groupCandidates = candidateDetails.slice();
      }

      for (const candidate of groupCandidates) {
        const info = roleInfoFor(candidate.url) || roleInfoFor(candidate.name);
        if (info?.role && !candidate._role) candidate._role = info.role;
        if (info?.hasVisibleText) candidate._hasText = true;
      }

      // Phase R2: New pure sorter
      if (USE_NEW_SORTER) {
        const folderUrls = groupCandidates.map(c => c.url);

        // Build insights with URL for matching in sorter
        const imageInsights = folderUrls.map(url => {
          const insight = insightMap.get(url);
          return {
            url,
            role: (insight?.role as "front" | "back" | null) || null,
            hasVisibleText: insight?.hasVisibleText ?? false,
            ocr: (insight as any)?.ocrText || "",
          };
        });

        const result = await frontBackStrict(
          folderUrls,
          imageInsights,
          {
            brand: (group as any).brand,
            product: (group as any).product,
            variant: (group as any).variant,
            size: (group as any).size
          },
          { getOCRForUrl, clipTextEmbedding, clipImageEmbedding, cosine }
        );

        group.heroUrl = result.heroUrl || undefined;
        group.backUrl = result.backUrl || undefined;
        group.primaryImageUrl = result.heroUrl || undefined;
        group.secondaryImageUrl = result.backUrl || undefined;
        group.images = result.images;

        if (debugEnabled) {
          console.log(`[Phase R2] Group ${groupId}:`, {
            name: (group as any).name || (group as any).product,
            heroUrl: result.heroUrl,
            backUrl: result.backUrl,
            images: result.images,
            insightsReceived: imageInsights.map(i => ({ url: i.url.split('/').pop(), role: i.role })),
            sample: result.debug.metas.slice(0, 4)
          });
        }

        // IMPORTANT: skip any old code that would re-rank or merge extra images
        continue;
      }

      // Phase 4: Role-based hero/back selection with fallbacks
      if (USE_NEW_SORTER && USE_ROLE_SORTING) {
        // Phase 5: Filter out noisy/dummy images by filename
        const noisy = (n: string) => {
          const s = n.toLowerCase();
          return (
            s.includes("dummy") ||
            s.includes("placeholder") ||
            s.includes("barcode") ||
            s.includes("qrcode") ||
            s.includes("sample") ||
            s.includes("template")
          );
        };

        const looksBack = (t: string, n?: string) => {
          t = (t || "").toLowerCase();
          n = (n || "").toLowerCase();
          return (
            t.includes("supplement facts") ||
            t.includes("nutrition facts") ||
            t.includes("ingredients") ||
            t.includes("drug facts") ||
            t.includes("directions") ||
            n.includes("back") ||
            n.includes("facts") ||
            n.includes("ingredients") ||
            n.includes("supplement")
          );
        };

        // Phase 2: Build fresh per-group candidate snapshot (DO NOT mutate shared arrays)
        // Include full metadata: folder, role, category, OCR
        const candidates = groupCandidates
          .filter((c) => !noisy(basenameFrom(c.url)))
          .map((c) => {
            const b = basenameFrom(c.url).toLowerCase();
            const info = roleByBase.get(b) || {};
            const groupCategory =
              (group as any).category ||
              (group as any).categoryPath ||
              "";
            return {
              url: c.url,
              name: c.name,
              folder: folderKey || folder,
              role: info.role || c._role || null,
              hasText: info.hasVisibleText ?? c._hasText ?? false,
              ocr: info.ocr || c.ocrText || "",
              category: info.category || groupCategory,
            };
          });

        // Phase 2: Debug log per-group snapshot
        if (debugEnabled) {
          console.log(`[Phase 2] Group ${groupId} snapshot (${candidates.length} candidates):`,
            candidates.slice(0, 5).map(c => ({
              url: basenameFrom(c.url),
              role: c.role,
              category: c.category?.substring(0, 30) || "(none)",
              ocrLength: c.ocr.length,
            }))
          );
        }

        // Phase 3: Apply hard gates before scoring
        const brand = String((group as any).brand || "").toLowerCase();
        const prod = String((group as any).product || "").toLowerCase();
        const tokens = [brand, prod].filter(Boolean);

        const brandScore = (t: string) => {
          const s = (t || "").toLowerCase();
          let sc = 0;
          for (const tk of tokens) if (tk && s.includes(tk)) sc++;
          return sc;
        };

        const isDummyName = (n: string) => {
          const s = (n || "").toLowerCase();
          return (
            s.includes("dummy") ||
            s.includes("placeholder") ||
            s.includes("barcode") ||
            s.includes("qrcode")
          );
        };

        // Phase 3: Generic category matching - compare parent categories if both exist
        const categoryMatches = (candidateCat: string, groupCat: string): boolean => {
          if (!candidateCat || !groupCat) return true; // Skip gate if either is missing
          const cLower = candidateCat.toLowerCase();
          const gLower = groupCat.toLowerCase();
          // Extract parent categories (text before '>')
          const cParent = cLower.split('>')[0].trim();
          const gParent = gLower.split('>')[0].trim();
          // Match if parent categories overlap or full strings match
          return cLower.includes(gParent) || gLower.includes(cParent) || cParent === gParent;
        };

        let gated = candidates.filter((c) => {
          // Folder gate: only images from same folder
          if (FOLDER_GATE && folderKey && c.folder !== folderKey) return false;

          // Category gate: optional, skips if group.category is null
          if (CATEGORY_GATE) {
            const groupCat = (group as any).category || (group as any).categoryPath || "";
            if (groupCat && c.category) {
              if (!categoryMatches(c.category, groupCat)) return false;
            }
          }

          // Brand gate: requires brand/product tokens in OCR
          if (BRAND_GATE && tokens.length > 0 && brandScore(c.ocr) < OCR_BRAND_MIN) return false;

          // Dummy filter: obvious dummies
          if (isDummyName(c.name)) return false;

          return true;
        });

        // If gating leaves 0, fall back to same-folder images (still safe)
        if (gated.length === 0) {
          gated = candidates.filter((c) => !folderKey || c.folder === folderKey);
        }
        if (gated.length === 0) {
          gated = candidates; // Last resort fallback
        }

        // Phase 3: Debug log gating results
        if (debugEnabled && gated.length !== candidates.length) {
          console.log(
            `[Phase 3] Group ${groupId} gating: ${candidates.length} → ${gated.length} (removed ${candidates.length - gated.length})`
          );
          const removed = candidates.filter((c) => !gated.includes(c));
          if (removed.length > 0) {
            console.log(
              `[Phase 3] Removed:`,
              removed.slice(0, 3).map((c) => ({
                url: basenameFrom(c.url),
                reason: [
                  FOLDER_GATE && folderKey && c.folder !== folderKey ? "folder" : null,
                  CATEGORY_GATE && !categoryMatches(c.category, (group as any).category || "") ? "category" : null,
                  BRAND_GATE && tokens.length > 0 && brandScore(c.ocr) < OCR_BRAND_MIN ? "brand" : null,
                  isDummyName(c.name) ? "dummy" : null,
                ]
                  .filter(Boolean)
                  .join(","),
              }))
            );
          }
        }

        // Adapt gated candidates to legacy format for hero/back selection
        const adaptedCandidates = gated.map((c) => ({
          url: c.url,
          name: c.name,
          _role: c.role,
          _ocr: c.ocr,
          _hasText: c.hasText,
          _category: c.category,
        }));

        // FRONT (hero): role 'front' > brand OCR > first
        let hero =
          adaptedCandidates.find((c) => c._role === "front") ||
          adaptedCandidates.slice().sort((a, b) => brandScore(b._ocr) - brandScore(a._ocr))[0] ||
          adaptedCandidates[0];

        group.heroUrl = hero?.url || undefined;
        if (group.heroUrl) {
          group.primaryImageUrl = group.heroUrl;
          heroOwnerByImage.set(group.heroUrl, groupId);
          const heroInsight = ensureInsightEntry(group.heroUrl);
          if (heroInsight && !heroInsight.role) heroInsight.role = "front";
          assignRoleInfo(group.heroUrl, { role: "front" });
        }

        // BACK: role 'back' > facts/ingredients OCR > CLIP-to-hero
        let back = adaptedCandidates.find((c) => c.url !== group.heroUrl && c._role === "back");
        if (!back) {
          back = adaptedCandidates
            .filter((c) => c.url !== group.heroUrl)
            .sort(
              (a, b) =>
                Number(looksBack(b._ocr, b.name)) - Number(looksBack(a._ocr, a.name)) ||
                brandScore(b._ocr) - brandScore(a._ocr)
            )[0];
        }
        if (!back && group.heroUrl) {
          const hv = await getImageVector(group.heroUrl);
          if (hv) {
            const scored = await Promise.all(
              adaptedCandidates
                .filter((c) => c.url !== group.heroUrl)
                .map(async (c) => {
                  const v = await getImageVector(c.url);
                  const s = v && v.length === hv.length ? cosine(v, hv) : 0;
                  return { c, s };
                })
            );
            scored.sort((a, b) => b.s - a.s);
            if (scored[0]?.s >= BACK_MIN_SIM) back = scored[0].c;
          }
        }
        group.backUrl = back?.url || undefined;
        if (group.backUrl) {
          group.secondaryImageUrl = group.backUrl;
          const backInsight = ensureInsightEntry(group.backUrl);
          if (backInsight && !backInsight.role) backInsight.role = "back";
          assignRoleInfo(group.backUrl, { role: "back" });
        }

        // Strict order: [hero, back, ...rest]
        const rest = adaptedCandidates.map((c) => c.url).filter((u) => u !== group.heroUrl && u !== group.backUrl);
        const orderedImages = [group.heroUrl, group.backUrl, ...rest].filter((url): url is string => Boolean(url));
        group.images = orderedImages;

        // 2-photo fast path when folder only had 2
        if (adaptedCandidates.length <= 2 && group.images) {
          group.images = group.images.slice(0, 2);
        }

        // Debug - Phase 2/3: Show snapshot and gating results
        if (debugEnabled) {
          console.log(`[Phase 4] Group ${groupId}:`, {
            name: (group as any).name || (group as any).product,
            heroUrl: group.heroUrl,
            backUrl: group.backUrl,
            originalSize: candidates.length,
            afterGating: gated.length,
            roles: gated.slice(0, 5).map((c) => ({
              url: basenameFrom(c.url),
              role: c.role,
              category: c.category?.substring(0, 30) || "(none)",
              brandScore: brandScore(c.ocr),
              looksBack: looksBack(c.ocr, c.name),
            })),
          });
        }

        const heroVec = group.heroUrl ? await getImageVector(group.heroUrl) : null;
        heroVectors.set(groupId, heroVec);
        const backVec = group.backUrl ? await getImageVector(group.backUrl) : null;
        backVectors.set(groupId, backVec);
        folderCandidatesByGroup.set(groupId, groupCandidates);
      } else {
        // Original logic (pre-Phase 4)
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
          const heroInsight = ensureInsightEntry(heroUrl);
          if (heroInsight && !heroInsight.role) heroInsight.role = "front";
          assignRoleInfo(heroUrl, { role: "front" });
          if (front) front._role = "front";
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
          const backInsight = ensureInsightEntry(back.url);
          if (backInsight && !backInsight.role) backInsight.role = "back";
          assignRoleInfo(back.url, { role: "back" });
          back._role = "back";
        } else if (secondaryHint && secondaryHint !== group.heroUrl) {
          group.backUrl = secondaryHint;
          group.secondaryImageUrl = secondaryHint;
          const backInsight = ensureInsightEntry(secondaryHint);
          if (backInsight && !backInsight.role) backInsight.role = "back";
          assignRoleInfo(secondaryHint, { role: "back" });
        } else {
          group.backUrl = undefined;
        }

        folderCandidatesByGroup.set(groupId, groupCandidates);

        heroVectors.set(groupId, heroVec);
        const backVec = group.backUrl ? await getImageVector(group.backUrl) : null;
        backVectors.set(groupId, backVec);

        group.images = cleaned;
      }
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
        const fallbackImages = STRICT_TWO_ONLY
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

      // Phase 1: Removed vision-suggested scoring (cross-pollution vector)

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
        clipContribution = Math.round(clipSim * CLIP_WEIGHT * 100) / 100;
      }

      if (components) {
        components.push({ label: "clip-hero", value: Number((simHero * 100).toFixed(1)), detail: simHero.toFixed(3) });
        if (backVectors.get(groupId)) {
          components.push({ label: "clip-back", value: Number((simBack * 100).toFixed(1)), detail: simBack.toFixed(3) });
        }
        components.push({
          label: "clip",
          value: Number(clipContribution.toFixed(2)),
          detail: `${clipSim.toFixed(3)} × ${CLIP_WEIGHT}`,
        });
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
          Array.isArray(group?.images) ? group.images.slice(0, STRICT_TWO_ONLY ? 2 : group.images.length) : []
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

    // Phase 1: Removed reassignedCount logic (relied on urlToGroups)

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

      // Normalize all URLs to basenames using urlKey
      const normalizedImages = finalImages
        .map(urlKey)
        .filter(k => k && k !== 'imgurl' && !k.startsWith('<')); // Skip placeholders
      const uniqueBasenames = Array.from(new Set(normalizedImages));
      
      const normalizedGroup = {
        ...group,
        images: uniqueBasenames,
        primaryImageUrl: group.primaryImageUrl ? urlKey(group.primaryImageUrl) : null,
        heroUrl: group.heroUrl ? urlKey(group.heroUrl) : (group.primaryImageUrl ? urlKey(group.primaryImageUrl) : null),
        backUrl: group.backUrl ? urlKey(group.backUrl) : null,
        secondaryImageUrl: group.secondaryImageUrl ? urlKey(group.secondaryImageUrl) : null,
      };
      
      normalizedGroups.push(normalizedGroup);
    }

    const orphanTuples = fileTuples.filter((tuple) => !usedUrls.has(tuple.url));
    // Phase 1: Removed reassignedCount warning (urlToGroups dependency)
    const orphans = hydrateOrphans(orphanTuples, folder);

    const payloadGroups = hydrateGroups(normalizedGroups, folder);

    const insightOutput = new Map<string, ImageInsight>();
    
    // Helper: detect facts panel cues for pairing
    const detectFactsCues = (insight: any): string[] => {
      const cues: string[] = [];
      const patterns = [
        'supplement facts',
        'nutrition facts',
        'drug facts',
        'serving size',
        'other ingredients',
        'ingredients:',
        'directions for use',
        'directions:',
        'warnings:',
        'allergen'
      ];
      
      // Check OCR text
      const ocrText = (insight?.ocrText || insight?.textExtracted || '').toLowerCase();
      const visualDesc = ((insight as any)?.visualDescription || '').toLowerCase();
      const combinedText = `${ocrText} ${visualDesc}`;
      
      for (const pattern of patterns) {
        if (combinedText.includes(pattern)) {
          cues.push(pattern);
        }
      }
      
      return cues;
    };
    
    const mergeInsight = (url: string | null | undefined, source?: Partial<ImageInsight>) => {
      if (!url) return;
      const normalized = toDirectDropbox(url);
      const current = insightOutput.get(normalized) || { url: normalized };
      if (source) {
        if (source.role && !current.role) current.role = source.role;
        if (source.hasVisibleText !== undefined && current.hasVisibleText === undefined) {
          current.hasVisibleText = source.hasVisibleText;
        }
        if (source.dominantColor && !current.dominantColor) current.dominantColor = source.dominantColor;
        if (source.ocrText && !current.ocrText) current.ocrText = source.ocrText;
        if (Array.isArray(source.textBlocks) && !current.textBlocks) current.textBlocks = source.textBlocks.slice();
        if (source.text && !current.text) current.text = source.text;
        if (source.ocr) {
          current.ocr = current.ocr || {};
          if (source.ocr.text && !current.ocr.text) current.ocr.text = source.ocr.text;
          if (Array.isArray(source.ocr.lines) && (!current.ocr.lines || current.ocr.lines.length === 0)) {
            current.ocr.lines = source.ocr.lines.slice();
          }
        }
        // NEW: Extract textExtracted and evidenceTriggers for pairing
        const textExtracted = source.ocrText || (source as any).textExtracted || '';
        if (textExtracted && !(current as any).textExtracted) {
          (current as any).textExtracted = textExtracted;
        }
        if (!Array.isArray((current as any).evidenceTriggers)) {
          (current as any).evidenceTriggers = detectFactsCues(source);
        }
      }
      insightOutput.set(normalized, current);
    };

    insightMap.forEach((insight, key) => {
      const source = insight || { url: key };
      mergeInsight(source.url || key, source);
    });

    fileTuples.forEach(({ url }) => mergeInsight(url));

    normalizedGroups.forEach((group) => {
      const hero = typeof group?.heroUrl === "string" ? group.heroUrl : null;
      const back = typeof group?.backUrl === "string" ? group.backUrl : null;
      if (hero) mergeInsight(hero, { role: "front" });
      if (back && back !== hero) mergeInsight(back, { role: "back" });
      const images = Array.isArray(group?.images) ? group.images : [];
      images.forEach((img: unknown) => {
        if (typeof img === "string") mergeInsight(img);
      });
    });

    // Function to compute displayUrl using harvested https URLs
    const computeDisplayUrl = (key: string): string => {
      // 1) Prefer an https URL we've already seen
      const https = httpsByKey.get(key);
      if (https) return https;

      // 2) Fall back to the original enumerated URL if it was https
      const orig = originalByKey.get(key) || '';
      if (/^https?:\/\//i.test(orig)) return orig;

      // 3) Last resort: return the key as-is (will be caught by validation)
      return key;
    };

    // De-duplicate imageInsights by key before returning
    const seen = new Set<string>();
    const uniqueInsights: Array<[string, ImageInsight]> = [];
    
    for (const [key, value] of insightOutput.entries()) {
      const normalized = toDirectDropbox(key);
      const insightKey = (value as any).key || urlKey(normalized);
      
      // Skip any lingering placeholder URLs
      if (!insightKey || insightKey === 'imgurl' || insightKey.startsWith('<')) {
        console.warn(`[role-index] Skipping placeholder URL: "${insightKey}" from "${key}"`);
        continue;
      }
      
      if (seen.has(insightKey)) continue;
      seen.add(insightKey);
      
      // Hydrate with proper displayUrl using harvested https URLs
      const displayUrl = computeDisplayUrl(insightKey);
      
      const insight = {
        ...value,
        url: normalized,
        key: insightKey,
        displayUrl
      } as ImageInsight;
      
      uniqueInsights.push([insightKey, insight]);
    }

    const imageInsightsRecord = Object.fromEntries(uniqueInsights);
    
    // Debug: log keys sample to verify no placeholders
    const keySample = Array.from(seen).slice(0, 12);
    console.log('[role-index] keys:', keySample);
    
    // Debug: check for duplicates
    const allKeys = Array.from(insightOutput.entries()).map(([k, v]) => (v as any).key || urlKey(toDirectDropbox(k)));
    const dupes = allKeys.filter((k, i) => allKeys.indexOf(k) !== i);
    if (dupes.length) {
      console.warn('[role-index] DUPES found (before dedup):', dupes);
    }
    
    // Debug: check for missing displayUrls
    const allInsights = Object.values(imageInsightsRecord) as any[];
    const noDisplay = allInsights.filter(x => !x.displayUrl || !/^https?:\/\//i.test(x.displayUrl));
    if (noDisplay.length > 0) {
      console.warn('[displayUrl] still missing https URLs:', noDisplay.map(x => ({ key: x.key, displayUrl: x.displayUrl })));
    } else {
      console.log('[displayUrl] ✓ All insights have valid display URLs');
    }

    // Build role map for hero/back selection
    const roleByKey = buildRoleMap(Object.values(imageInsightsRecord));

    // Helper: pick hero and back from group images based on vision roles
    function pickHeroBackForGroup(g: any, roleByKey: Map<string, { role: string; score: number }>) {
      const images = g.images || [];
      if (images.length === 0) return;

      // Partition by role
      const fronts: string[] = [];
      const backs: string[] = [];
      const sides: string[] = [];
      const others: string[] = [];

      for (const img of images) {
        const key = typeof img === 'string' ? urlKey(img) : urlKey(img.url || '');
        const entry = roleByKey.get(key);
        const role = entry?.role || 'other';
        
        if (role === 'front') fronts.push(img);
        else if (role === 'back') backs.push(img);
        else if (role === 'side') sides.push(img);
        else others.push(img);
      }

      // Sort each partition by |roleScore| descending
      const sortByScore = (arr: any[]) => {
        arr.sort((a, b) => {
          const keyA = typeof a === 'string' ? urlKey(a) : urlKey(a.url || '');
          const keyB = typeof b === 'string' ? urlKey(b) : urlKey(b.url || '');
          const scoreA = Math.abs(roleByKey.get(keyA)?.score || 0);
          const scoreB = Math.abs(roleByKey.get(keyB)?.score || 0);
          return scoreB - scoreA;
        });
      };

      sortByScore(fronts);
      sortByScore(backs);
      sortByScore(sides);
      sortByScore(others);

      // Pick hero: front > side > other > any
      let hero = fronts[0] || sides[0] || others[0] || images[0];
      
      // Pick back: back > second front > different side > null
      let back: any = backs[0];
      if (!back && fronts.length >= 2) back = fronts[1];
      if (!back && sides.length >= 1 && sides[0] !== hero) back = sides[0];
      if (!back && sides.length >= 2) back = sides[1];

      // Ensure hero ≠ back
      if (back && hero === back) {
        // Separate them
        const allOthers = [...fronts, ...sides, ...others, ...backs].filter(x => x !== hero);
        back = allOthers[0];
      }

      // Extract keys for heroUrl and backUrl
      g.heroUrl = hero ? (typeof hero === 'string' ? urlKey(hero) : urlKey(hero.url || '')) : null;
      g.backUrl = back ? (typeof back === 'string' ? urlKey(back) : urlKey(back.url || '')) : null;

      // Optional: attach display URLs
      g.heroDisplayUrl = g.heroUrl ? (httpsByKey.get(g.heroUrl) || `/files/${encodeURIComponent(g.heroUrl)}`) : null;
      g.backDisplayUrl = g.backUrl ? (httpsByKey.get(g.backUrl) || `/files/${encodeURIComponent(g.backUrl)}`) : null;

      // Reorder images: [hero, back, ...rest]
      const rest = images.filter((x: any) => x !== hero && x !== back);
      g.images = [hero, back, ...rest].filter(Boolean);
    }

    // Apply hero/back selection to all normalized groups
    for (const g of normalizedGroups) {
      pickHeroBackForGroup(g, roleByKey);
    }

    // Debug: log hero/back for each group
    for (const g of normalizedGroups) {
      console.log('[hero-back]', g.name || g.groupId, 'hero=', g.heroUrl, 'back=', g.backUrl);
    }

    const cachePayload: SmartDraftGroupCache = {
      signature,
      groups: payloadGroups,
      orphans,
      warnings,
      imageInsights: Object.keys(imageInsightsRecord).length ? imageInsightsRecord : undefined,
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
      imageInsights: imageInsightsRecord,
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
        provider: providerMeta.provider,
        textBase: providerMeta.textBase,
        imageBase: providerMeta.imageBase,
        textDim: firstImageDim, // Text and image use same dimension for CLIP
        imgDim: firstImageDim,
        weight: CLIP_WEIGHT,
        minSimilarity: CLIP_MIN_SIM,
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

      // Phase 6: Enhanced debug output
      responsePayload.debug = {
        minAssign: MIN_ASSIGN,
        clip: clipDebug,
        groups: debugGroups,
        ...(duplicatesDebug ? { duplicates: duplicatesDebug } : {}),
        phase6: {
          useNewSorter: USE_NEW_SORTER,
          useRoleSorting: USE_ROLE_SORTING,
          strictTwoOnly: STRICT_TWO_ONLY,
          folderGateEnabled: true,
          visionSortDisabled: true,
          message: "Phase 0-5 complete: role-based sorting with folder isolation",
        },
      };
    }

    // Final hydration: ensure all imageInsights have valid display URLs
    finalizeDisplayUrls(responsePayload, {
      httpsByKey,
      originalByKey,
      folderParam: folder,
      publicFilesBase: '/files', // Optional: proxy base for local serving
    });

    return jsonEnvelope(200, responsePayload);
  } catch (err: any) {
    return jsonEnvelope(500, { ok: false, error: err?.message || String(err) });
  }
}
