const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function call(path: string[]) {
  if (!BASE || !TOKEN) {
    throw new Error("Upstash not configured");
  }

  const url = `${BASE}/${path.map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash ${res.status}: ${text}`);
  }

  const data: any = await res.json().catch(() => null);
  return data?.result ?? null;
}

function bindKey(userId: string, jobId: string, groupId: string) {
  return `map:${userId}:${jobId}:${groupId}`;
}

export async function putBinding(userId: string, jobId: string, groupId: string, payload: any) {
  const key = bindKey(userId, jobId, groupId);
  await call(["SET", key, JSON.stringify({ ...payload, updatedAt: Date.now() })]);
  return key;
}

export async function getBindingsForJob(userId: string, jobId: string) {
  const pattern = `map:${userId}:${jobId}:*`;
  const keys = await call(["KEYS", pattern]);
  const rows: any[] = [];

  if (!Array.isArray(keys)) return rows;

  for (const key of keys) {
    try {
      const raw = await call(["GET", String(key)]);
      if (typeof raw !== "string" || !raw) continue;
      rows.push(JSON.parse(raw));
    } catch (err) {
      console.warn("[bind-store] failed to parse binding", err);
    }
  }

  return rows;
}

/**
 * Find binding by SKU across all jobs for a user.
 * Returns the groupId for this SKU if found.
 */
export async function getGroupIdBySku(userId: string, sku: string): Promise<string | null> {
  // Search all bindings for this user
  const pattern = `map:${userId}:*`;
  const keys = await call(["KEYS", pattern]);
  
  if (!Array.isArray(keys)) return null;

  for (const key of keys) {
    try {
      const raw = await call(["GET", String(key)]);
      if (typeof raw !== "string" || !raw) continue;
      const binding = JSON.parse(raw);
      if (binding.sku === sku) {
        return binding.groupId || null;
      }
    } catch (err) {
      // Skip invalid bindings
    }
  }

  return null;
}
