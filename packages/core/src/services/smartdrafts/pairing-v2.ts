/**
 * packages/core/src/services/smartdrafts/pairing-v2.ts
 *
 * Start and poll pairing-v2 background jobs.
 * Delegates to pairingV2Jobs.ts which manages the Redis job records.
 */

import {
  schedulePairingV2Job,
  getPairingV2JobStatus,
  type PairingV2Job,
} from '../../../../../src/lib/pairingV2Jobs.js';

export type { PairingV2Job };

export class PairingJobNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(jobId: string) {
    super(`Pairing job ${jobId} not found`);
    this.name = 'PairingJobNotFoundError';
  }
}

export type PairingV2StartParams = {
  /** Dropbox folder path (mutually exclusive with stagedUrls) */
  folder?: string;
  /** Pre-staged image URLs from ingestion system (mutually exclusive with folder) */
  stagedUrls?: string[];
  force?: boolean;
  limit?: number;
  debug?: boolean;
};

export class InvalidPairingParamsError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPairingParamsError';
  }
}

/**
 * Validate params and schedule a new pairing-v2 background job.
 * Returns the new jobId.
 */
export async function startPairingV2Job(
  userId: string,
  params: PairingV2StartParams,
): Promise<{ jobId: string }> {
  const { folder, stagedUrls = [], force, limit, debug } = params;

  if (!folder && stagedUrls.length === 0) {
    throw new InvalidPairingParamsError(
      "Provide either 'folder' (Dropbox folder path) or 'stagedUrls' (uploaded files)",
    );
  }
  if (folder && stagedUrls.length > 0) {
    throw new InvalidPairingParamsError("Provide 'folder' or 'stagedUrls' — not both");
  }

  const jobId = await schedulePairingV2Job(
    userId,
    folder || '',
    stagedUrls.length > 0 ? stagedUrls : [],
    undefined, // accessToken — retrieved from Redis by the processor
  );

  return { jobId };
}

/**
 * Poll the status of an existing pairing-v2 job.
 *
 * @throws {PairingJobNotFoundError} if the job does not exist.
 */
export async function getPairingV2Status(
  jobId: string,
): Promise<PairingV2Job> {
  const status = await getPairingV2JobStatus(jobId);
  if (!status) throw new PairingJobNotFoundError(jobId);
  return status;
}
