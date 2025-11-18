/**
 * SmartDrafts job-level metrics tracking
 * Phase 4: Telemetry, Tuning & Guardrails
 */

export interface SmartdraftsMetrics {
  jobId: string;
  folder?: string;
  cached?: boolean;
  // Inputs
  imageCount?: number;
  uniqueImageKeys?: number; // from dedupe, if available
  // Timing
  visionMs?: number;
  totalScanMs?: number;
  pairingMs?: number;
  draftsMs?: number;
  // Outputs
  productCount?: number;
  pairCount?: number;
  singletonCount?: number;
  orphanImageCount?: number;
  // Flags
  usedDownscale?: boolean;
  visionConcurrency?: number;
}

export function newMetrics(jobId: string): SmartdraftsMetrics {
  return { jobId };
}

export function logMetrics(stage: string, m: SmartdraftsMetrics) {
  console.log(`[smartdrafts-metrics] ${stage}`, m);
}
