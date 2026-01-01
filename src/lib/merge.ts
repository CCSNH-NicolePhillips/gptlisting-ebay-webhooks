import crypto from "crypto";

/**
 * Convert a Dropbox "share" URL into a direct-download URL
 * Example:
 *  www.dropbox.com/scl/fo/...?...dl=0  →  dl.dropboxusercontent.com/scl/fo/...
 */
export function toDirectDropbox(url: string): string {
  try {
    if (!url) return url;
    let clean = url.trim();
    clean = clean
      .replace("www.dropbox.com", "dl.dropboxusercontent.com")
      .replace("dropbox.com", "dl.dropboxusercontent.com");
    clean = clean.replace(/\?dl=\d/, "");
    return clean;
  } catch {
    return url;
  }
}

export function sanitizeUrls(urls: string[] = []): string[] {
  const set = new Set<string>();
  for (const raw of urls) {
    const val = (raw || "").trim();
    if (!val) continue;
    set.add(val);
  }
  return Array.from(set);
}

function makeSignature(g: any): string {
  const normalize = (val: unknown): string => {
    const str = String(val ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!str) return "";
    if (["unknown", "not specified", "not available", "n a", "na", "none"].includes(str)) {
      return "";
    }
    return str;
  };

  const raw = [g.brand, g.product, g.variant, g.size]
    .map(normalize)
    .join("|")
    .replace(/\|+/g, "|")
    .replace(/^\|+|\|+$/g, "");

  return crypto.createHash("sha1").update(raw).digest("hex");
}

function normalizeOptions(input: any): Record<string, string[]> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, string[]> = {};
  Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
    const cleanKey = typeof key === "string" ? key.trim() : "";
    if (!cleanKey) return;
    const raw = Array.isArray(value) ? value : [value];
    const normalized = Array.from(
      new Set(
        raw
          .map((entry) => (entry === undefined || entry === null ? "" : String(entry).trim()))
          .filter(Boolean)
      )
    );
    if (normalized.length) out[cleanKey] = normalized;
  });
  return Object.keys(out).length ? out : undefined;
}

function mergeOptionMaps(existing: any, incoming: any): Record<string, string[]> | undefined {
  const base = normalizeOptions(existing) || {};
  const next = normalizeOptions(incoming) || {};
  const merged: Record<string, string[]> = { ...base };
  Object.entries(next).forEach(([key, values]) => {
    const current = merged[key] || [];
    const set = new Set(current.map((entry) => String(entry)));
    values.forEach((value) => set.add(String(value)));
    merged[key] = Array.from(set);
  });
  return Object.keys(merged).length ? merged : undefined;
}

function collectImages(source: any, extras: unknown[] = []): { list: string[]; set: Set<string> } {
  const seen = new Set<string>();
  const list: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = toDirectDropbox(trimmed);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    list.push(normalized);
  };

  if (Array.isArray(source)) {
    for (const entry of source) add(entry);
  }

  for (const extra of extras) add(extra);

  return { list, set: seen };
}

/**
 * Merge multiple OpenAI Vision results into one clean groups array
 */
export function mergeGroups(parts: { groups?: any[] }[]): { groups: any[] } {
  type BucketEntry = {
    group: any;
    images: string[];
    imageSet: Set<string>;
  };

  const buckets = new Map<string, BucketEntry[]>();

  const key = (g: any) =>
    [g.brand, g.product, g.variant].map((x: string) => (x || "").toLowerCase().trim()).join("|");

  const appendImages = (entry: BucketEntry, additions: string[]) => {
    for (const url of additions) {
      if (entry.imageSet.has(url)) continue;
      entry.imageSet.add(url);
      entry.images.push(url);
    }
    entry.group.images = entry.images.slice();
  };

  for (const part of parts) {
    for (const g of part.groups || []) {
      const extras = [g.primaryImageUrl, g.heroUrl, g.secondaryImageUrl, g.backUrl];
      const { list: candidateImages, set: candidateSet } = collectImages(g.images, extras);
      const bucketKey = key(g);
      const bucket = buckets.get(bucketKey) || [];

      const normalizedClaims = Array.from(
        new Set(
          (Array.isArray(g.claims) ? g.claims : [])
            .map((claim: unknown) => (claim === undefined || claim === null ? "" : String(claim).trim()))
            .filter(Boolean)
        )
      );

      let target: BucketEntry | undefined;
      if (candidateImages.length) {
        target = bucket.find((entry) => candidateImages.some((url) => entry.imageSet.has(url)));
      }

      if (!target) {
        const entry: BucketEntry = {
          group: {
            ...g,
            options: normalizeOptions(g.options),
            images: candidateImages.slice(),
            claims: normalizedClaims,
          },
          images: candidateImages.slice(),
          imageSet: new Set(candidateImages),
        };
        bucket.push(entry);
        buckets.set(bucketKey, bucket);
        continue;
      }

      const existing = target.group;
      appendImages(target, candidateImages);

      const incomingClaims = Array.isArray(g.claims)
        ? g.claims.map((claim: unknown) => (claim === undefined || claim === null ? "" : String(claim).trim()))
        : [];
      const mergedClaims = new Set([
        ...(existing.claims || []),
        ...incomingClaims.filter(Boolean),
      ]);
      existing.claims = Array.from(mergedClaims);

      existing.options = mergeOptionMaps(existing.options, g.options);
      if (!existing.brand && g.brand) existing.brand = g.brand;
      if (!existing.product && g.product) existing.product = g.product;
      if (!existing.variant && g.variant) existing.variant = g.variant;
      if (!existing.category && g.category) existing.category = g.category;

      const existingDepth = typeof existing.categoryPath === "string"
        ? existing.categoryPath.split(">").filter((part: string) => part.trim()).length
        : 0;
      const newDepth = typeof g.categoryPath === "string"
        ? g.categoryPath.split(">").filter((part: string) => part.trim()).length
        : 0;
      if (!existing.categoryPath && g.categoryPath) {
        existing.categoryPath = g.categoryPath;
      } else if (newDepth > existingDepth) {
        existing.categoryPath = g.categoryPath;
      }

      existing.confidence = Math.max(existing.confidence || 0, g.confidence || 0);
      if (!existing.primaryImageUrl && typeof g.primaryImageUrl === "string") {
        existing.primaryImageUrl = g.primaryImageUrl;
      }
      if (!existing.secondaryImageUrl && typeof g.secondaryImageUrl === "string") {
        existing.secondaryImageUrl = g.secondaryImageUrl;
      }
      if (!existing.heroUrl && typeof g.heroUrl === "string") {
        existing.heroUrl = g.heroUrl;
      }
      if (!existing.backUrl && typeof g.backUrl === "string") {
        existing.backUrl = g.backUrl;
      }
    }
  }

  const merged: any[] = [];

  for (const bucket of buckets.values()) {
    bucket.forEach((entry, index) => {
      entry.group.images = entry.images.slice();
      const sig = makeSignature(entry.group);
      const suffix = bucket.length > 1 ? `_${index + 1}` : "";
      entry.group.groupId = `grp_${sig.slice(0, 8)}${suffix}`;
      merged.push(entry.group);
    });
  }

  merged.sort((a, b) => {
    const left = `${a.brand || ""}${a.product || ""}${a.variant || ""}${a.groupId || ""}`.toLowerCase();
    const right = `${b.brand || ""}${b.product || ""}${b.variant || ""}${b.groupId || ""}`.toLowerCase();
    return left.localeCompare(right);
  });

  return { groups: merged };
}
