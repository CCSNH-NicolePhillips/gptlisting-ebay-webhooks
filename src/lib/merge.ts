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
  const raw = [
    g.brand || "",
    g.product || "",
    g.variant || "",
    g.size || "",
  ]
    .join("|")
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return crypto.createHash("sha1").update(raw).digest("hex");
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
        map.set(k, {
          ...g,
          images: [...(g.images || [])],
          claims: Array.from(new Set(g.claims || [])),
        });
      } else {
        const existing = map.get(k);
        const mergedImages = new Set([
          ...(existing.images || []),
          ...(g.images || []),
        ]);
        existing.images = Array.from(mergedImages);
        const mergedClaims = new Set([
          ...(existing.claims || []),
          ...(g.claims || []),
        ]);
        existing.claims = Array.from(mergedClaims);
        existing.confidence = Math.max(existing.confidence || 0, g.confidence || 0);
      }
    }
  }

  for (const g of map.values()) {
    if (!g.groupId) {
      const sig = makeSignature(g);
      g.groupId = `grp_${sig.slice(0, 8)}`;
    }
  }

  const sorted = Array.from(map.values()).sort((a, b) =>
    `${a.brand}${a.product}${a.variant}`.localeCompare(`${b.brand}${b.product}${b.variant}`)
  );

  return { groups: sorted };
}
