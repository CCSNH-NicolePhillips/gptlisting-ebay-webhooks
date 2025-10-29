import crypto from "crypto";

/**
 * Convert a Dropbox "share" URL into a direct-download URL
 * Example:
 *  www.dropbox.com/scl/fo/...?...dl=0  →  dl.dropboxusercontent.com/scl/fo/...
 */
export function toDirectDropbox(url: string): string {
  try {
    if (!url) return url;
    const trimmed = url.trim();

    // Fast path: if not a Dropbox URL, return as-is
    if (!/dropbox\.com/i.test(trimmed)) return trimmed;

    // Use URL API to safely manipulate host and query params
    const u = new URL(trimmed);
    // Normalize host to direct-content endpoint
    if (u.hostname.endsWith("dropbox.com")) {
      u.hostname = "dl.dropboxusercontent.com";
    }

    // Remove the ambiguous dl param if present (dl=0 or dl=1)
    if (u.searchParams.has("dl")) {
      u.searchParams.delete("dl");
    }

    // Ensure raw=1 to nudge consistent content delivery (harmless if redundant)
    if (!u.searchParams.has("raw")) {
      u.searchParams.set("raw", "1");
    }

    return u.toString();
  } catch {
    // Fallback to string replacements if URL parsing fails
    try {
      let clean = url.trim();
      clean = clean
        .replace("www.dropbox.com", "dl.dropboxusercontent.com")
        .replace("dropbox.com", "dl.dropboxusercontent.com")
        .replace(/([?&])dl=\d(&|$)/, "$1")
        .replace(/[?&]$/, "");
      if (!/[?&]raw=1(?!\d)/.test(clean)) {
        clean += (clean.includes("?") ? "&" : "?") + "raw=1";
      }
      return clean;
    } catch {
      return url;
    }
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

/**
 * Merge multiple OpenAI Vision results into one clean groups array
 */
export function mergeGroups(parts: { groups?: any[] }[]): { groups: any[] } {
  const map = new Map<string, any>();

  const key = (g: any) =>
    [g.brand, g.product, g.variant].map((x: string) => (x || "").toLowerCase().trim()).join("|");

  for (const part of parts) {
    for (const g of part.groups || []) {
      const k = key(g);
      if (!map.has(k)) {
        const normalizedClaims = Array.from(
          new Set(
            (Array.isArray(g.claims) ? g.claims : [])
              .map((claim: unknown) => (claim === undefined || claim === null ? "" : String(claim).trim()))
              .filter(Boolean)
          )
        );
        map.set(k, {
          ...g,
          options: normalizeOptions(g.options),
          images: [...(g.images || [])],
          claims: normalizedClaims,
        });
      } else {
        const existing = map.get(k);
        const mergedImages = new Set([
          ...(existing.images || []),
          ...(g.images || []),
        ]);
        existing.images = Array.from(mergedImages);
        const incomingClaims = Array.isArray(g.claims)
          ? g.claims.map((claim: unknown) => (claim === undefined || claim === null ? "" : String(claim).trim()))
          : [];
        const mergedClaims = new Set([
          ...(existing.claims || []),
          ...incomingClaims.filter(Boolean),
        ]);
        existing.claims = Array.from(mergedClaims);
        existing.options = mergeOptionMaps(existing.options, g.options);
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
      }
    }
  }

  for (const g of map.values()) {
    const sig = makeSignature(g);
    g.groupId = `grp_${sig.slice(0, 8)}`;
  }

  const sorted = Array.from(map.values()).sort((a, b) =>
    `${a.brand}${a.product}${a.variant}`.localeCompare(`${b.brand}${b.product}${b.variant}`)
  );

  return { groups: sorted };
}
