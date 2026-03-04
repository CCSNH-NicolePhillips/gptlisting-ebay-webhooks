/**
 * packages/core/src/services/smartdrafts/reset.ts
 *
 * Clear all cached Redis job/price data for a user.
 */

import { clearUserJobs } from '../../../../../src/lib/job-store.js';

export async function resetSmartDrafts(userId: string): Promise<{ cleared: number }> {
  const cleared = await clearUserJobs(userId);
  return { cleared };
}
