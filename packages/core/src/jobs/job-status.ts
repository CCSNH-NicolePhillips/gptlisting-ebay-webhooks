/**
 * Canonical job lifecycle status values used across all pipelines.
 *
 *   pending    - job created, not yet picked up by background worker
 *   processing - background worker is actively running
 *   completed  - job finished successfully
 *   failed     - job ended with an error
 */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Reads job status from a raw Redis job record, normalizing legacy `state`
 * field values (used by older scan/analyze/drafts pipelines) to the canonical
 * `JobStatus` vocabulary.
 *
 * Legacy `state` mappings:
 *   pending   → pending
 *   running   → processing
 *   complete  → completed
 *   completed → completed
 *   error     → failed
 *   failed    → failed
 *
 * New pipelines (pairing-v2, quick-list) already write `status` with canonical
 * values — those are returned unchanged for terminal values.  Domain-specific
 * intermediate values written by quick-list ("pairing", "creating-drafts") are
 * mapped to `processing`.
 *
 * @param job - Raw job record from Redis (may be any shape).
 * @returns   Canonical `JobStatus`.
 */
export function normalizeJobStatus(job: Record<string, unknown>): JobStatus {
  // --- New `status` field (pairing-v2, quick-list, and newly migrated pipelines) ---
  const s = job?.status;
  if (s === 'pending') return 'pending';
  if (s === 'processing') return 'processing';
  if (s === 'completed') return 'completed';
  if (s === 'failed') return 'failed';
  // Domain-specific intermediate values from quick-list processor → in-flight
  if (typeof s === 'string' && s.length > 0) return 'processing';

  // --- Legacy `state` field (scan / analyze-images / create-drafts pipelines) ---
  const st = job?.state;
  if (st === 'pending') return 'pending';
  if (st === 'running') return 'processing';
  if (st === 'complete' || st === 'completed') return 'completed';
  if (st === 'error' || st === 'failed') return 'failed';

  // Unknown / missing → treat as pending (job was just created)
  return 'pending';
}
