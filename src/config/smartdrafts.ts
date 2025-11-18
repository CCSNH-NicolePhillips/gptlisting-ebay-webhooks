/**
 * SmartDrafts centralized configuration with validation and guardrails
 * Phase 4: Telemetry, Tuning & Guardrails
 */

export const config = {
  visionConcurrency: (() => {
    const raw = process.env.VISION_CONCURRENCY ?? '1';
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 && n <= 16 ? Math.floor(n) : 1;
  })(),
  
  visionDownscaleEnabled: (process.env.VISION_DOWNSCALE_ENABLED ?? 'false').toLowerCase() === 'true',
  
  visionDownscaleMaxSize: (() => {
    const raw = process.env.VISION_DOWNSCALE_MAX_SIZE ?? '1024';
    const n = Number(raw);
    return Number.isFinite(n) && n >= 256 && n <= 4096 ? Math.floor(n) : 1024;
  })(),
  
  pairCandidateK: (() => {
    const raw = process.env.PAIR_CANDIDATE_K ?? '8';
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 && n <= 32 ? Math.floor(n) : 8;
  })(),
  
  maxFilesPerBatch: (() => {
    const raw = process.env.MAX_FILES_PER_BATCH ?? '200';
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 && n <= 1000 ? Math.floor(n) : 200;
  })(),
};

// Log config on module load (appears once per cold start)
console.log('[smartdrafts-config]', config);
