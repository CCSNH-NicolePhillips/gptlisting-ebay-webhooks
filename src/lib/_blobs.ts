/**
 * Token/Cache Storage - Redis-backed (migrated from Netlify Blobs)
 * 
 * Uses Upstash Redis REST API for persistent storage.
 * Drop-in replacement for Netlify Blobs getStore() API.
 */

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// TTLs
const TOKEN_TTL_SEC = 60 * 60 * 24 * 90; // 90 days for OAuth tokens
const CACHE_TTL_SEC = 60 * 60 * 24 * 7;  // 7 days for cache data

async function redisCall(...parts: string[]): Promise<{ result: unknown }> {
  if (!BASE || !TOKEN) {
    throw new Error("Upstash Redis not configured (UPSTASH_REDIS_REST_URL/TOKEN missing)");
  }

  const encoded = parts.map((p) => encodeURIComponent(p));
  const url = `${BASE}/${encoded.join("/")}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }

  return res.json() as Promise<{ result: unknown }>;
}

/**
 * Redis-backed store that mimics Netlify Blobs API
 */
class RedisStore {
  private prefix: string;
  private ttl: number;

  constructor(name: string, ttl: number) {
    this.prefix = `blob:${name}:`;
    this.ttl = ttl;
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  async get(name: string, options?: { type?: 'json' | 'text' | 'blob' }): Promise<any> {
    try {
      const resp = await redisCall("GET", this.key(name));
      const val = resp.result;
      if (typeof val !== "string" || !val) return null;
      
      if (options?.type === 'json') {
        try {
          return JSON.parse(val);
        } catch {
          return null;
        }
      }
      return val;
    } catch (err) {
      console.error(`[redis-store] GET ${name} failed:`, err);
      return null;
    }
  }

  async set(name: string, value: unknown): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await redisCall("SETEX", this.key(name), `${this.ttl}`, serialized);
  }

  async setJSON(name: string, value: unknown): Promise<void> {
    await this.set(name, JSON.stringify(value));
  }

  async delete(name: string): Promise<void> {
    await redisCall("DEL", this.key(name));
  }

  async list(): Promise<{ blobs: Array<{ key: string }> }> {
    try {
      const pattern = `${this.prefix}*`;
      const resp = await redisCall("KEYS", pattern);
      const keys = Array.isArray(resp.result) ? resp.result : [];
      const blobs = keys
        .filter((k): k is string => typeof k === 'string')
        .map(k => ({ key: k.replace(this.prefix, '') }));
      return { blobs };
    } catch (err) {
      console.error(`[redis-store] LIST failed:`, err);
      return { blobs: [] };
    }
  }
}

// Singleton stores
let _tokensStore: RedisStore | null = null;
let _cacheStore: RedisStore | null = null;

export function tokensStore(): RedisStore {
  if (!_tokensStore) {
    _tokensStore = new RedisStore('tokens', TOKEN_TTL_SEC);
  }
  return _tokensStore;
}

export function cacheStore(): RedisStore {
  if (!_cacheStore) {
    _cacheStore = new RedisStore('cache', CACHE_TTL_SEC);
  }
  return _cacheStore;
}
