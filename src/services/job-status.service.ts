/**
 * job-status.service.ts — Platform-agnostic service for reading background job status.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/smartdrafts-create-drafts-status.ts
 *   netlify/functions/smartdrafts-scan-status.ts
 *
 * No HTTP framework dependencies.
 */

import { getJob } from '../lib/job-store.js';
import { k } from '../lib/user-keys.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetJobStatusResult {
  ok: true;
  job: unknown;
}

export class JobNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// getJobStatus
// ---------------------------------------------------------------------------

/**
 * Read the current status of a background job from Redis.
 *
 * @throws {JobNotFoundError} if no job exists with the given ID for the user.
 */
export async function getJobStatus(
  userId: string,
  jobId: string,
): Promise<GetJobStatusResult> {
  const jobKey = k.job(userId, jobId);
  const job = await getJob(jobId, { key: jobKey });

  if (!job) {
    throw new JobNotFoundError(jobId);
  }

  return { ok: true, job };
}
