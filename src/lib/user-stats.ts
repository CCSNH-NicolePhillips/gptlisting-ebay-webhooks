/**
 * User Stats Tracking
 * 
 * Tracks user activity metrics in Redis:
 * - Drafts created this week
 * - Time saved (estimated)
 */

const STATS_KEY_PREFIX = 'stats:';
const WEEK_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

// Redis helper (same pattern as job-store)
async function redisCall(...parts: string[]) {
  const base = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!base || !tok) {
    console.warn('[user-stats] Redis not configured');
    return { result: null };
  }
  
  const encoded = parts.map((p) => encodeURIComponent(p));
  const url = `${base}/${encoded.join("/")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Get the Monday of the current week (UTC) as YYYY-MM-DD
 */
function getCurrentWeekKey(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  const monday = new Date(now.setUTCDate(diff));
  return monday.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Record drafts created for a user
 * @param userId - Auth0 user ID
 * @param count - Number of drafts created
 * @param estimatedMinutesPerDraft - Estimated time saved per draft (default 5 min)
 */
export async function recordDraftsCreated(
  userId: string,
  count: number,
  estimatedMinutesPerDraft: number = 5
): Promise<void> {
  if (!userId || count <= 0) return;

  const weekKey = getCurrentWeekKey();
  const key = `${STATS_KEY_PREFIX}${userId}:${weekKey}`;

  try {
    // Get existing stats
    const existing = await redisCall('GET', key);
    let stats = { draftsWeek: 0, timeSavedMinutes: 0 };
    
    if (existing?.result && typeof existing.result === 'string') {
      try {
        stats = JSON.parse(existing.result);
      } catch {
        // Invalid JSON, start fresh
      }
    }

    // Update stats
    stats.draftsWeek = (stats.draftsWeek || 0) + count;
    stats.timeSavedMinutes = (stats.timeSavedMinutes || 0) + (count * estimatedMinutesPerDraft);

    // Save with TTL
    await redisCall('SET', key, JSON.stringify(stats));
    await redisCall('EXPIRE', key, String(WEEK_TTL));

    console.log(`[user-stats] Recorded ${count} drafts for user ${userId.slice(0, 20)}... (total this week: ${stats.draftsWeek})`);
  } catch (error) {
    console.warn('[user-stats] Failed to record drafts:', error);
    // Non-blocking - don't throw
  }
}

/**
 * Get user stats for the current week
 * @param userId - Auth0 user ID
 */
export async function getUserStats(userId: string): Promise<{
  draftsWeek: number;
  timeSavedMinutes: number;
}> {
  if (!userId) {
    return { draftsWeek: 0, timeSavedMinutes: 0 };
  }

  const weekKey = getCurrentWeekKey();
  const key = `${STATS_KEY_PREFIX}${userId}:${weekKey}`;

  try {
    const result = await redisCall('GET', key);
    
    if (result?.result && typeof result.result === 'string') {
      const stats = JSON.parse(result.result);
      return {
        draftsWeek: stats.draftsWeek || 0,
        timeSavedMinutes: stats.timeSavedMinutes || 0,
      };
    }
  } catch (error) {
    console.warn('[user-stats] Failed to get stats:', error);
  }

  return { draftsWeek: 0, timeSavedMinutes: 0 };
}

/**
 * Get global stats (sum across all users for the current week)
 * This is more expensive - scans all stats keys
 */
export async function getGlobalStats(): Promise<{
  draftsWeek: number;
  timeSavedMinutes: number;
}> {
  const weekKey = getCurrentWeekKey();
  const pattern = `${STATS_KEY_PREFIX}*:${weekKey}`;

  try {
    // Scan for all stats keys for this week
    const scanResult = await redisCall('SCAN', '0', 'MATCH', pattern, 'COUNT', '100');
    const keys = scanResult?.result?.[1] || [];

    let totalDrafts = 0;
    let totalMinutes = 0;

    // Get values for each key
    for (const key of keys) {
      try {
        const result = await redisCall('GET', key);
        if (result?.result && typeof result.result === 'string') {
          const stats = JSON.parse(result.result);
          totalDrafts += stats.draftsWeek || 0;
          totalMinutes += stats.timeSavedMinutes || 0;
        }
      } catch {
        // Skip invalid entries
      }
    }

    return {
      draftsWeek: totalDrafts,
      timeSavedMinutes: totalMinutes,
    };
  } catch (error) {
    console.warn('[user-stats] Failed to get global stats:', error);
    return { draftsWeek: 0, timeSavedMinutes: 0 };
  }
}
