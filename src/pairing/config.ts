// Centralized configuration for pairing thresholds and boosts
// Can be overridden via environment variables

export const ENGINE_VERSION = '1.0.0';

export const cfg = {
  // Candidate gate: minimum preScore to consider as candidate
  minPreScore: parseFloat(process.env.PAIR_MIN_PRESCORE || '1.5'),
  
  // General autopair (supplements/food with strong signals)
  autoPair: {
    score: parseFloat(process.env.PAIR_AUTO_SCORE || '3.0'),
    gap: parseFloat(process.env.PAIR_AUTO_GAP || '1.0')
  },
  
  // Hair/cosmetics fallback (INCI-based, lower threshold)
  autoPairHair: {
    score: parseFloat(process.env.PAIR_AUTO_HAIR_SCORE || '2.4'),
    gap: parseFloat(process.env.PAIR_AUTO_HAIR_GAP || '0.8')
  },
  
  // Packaging boosts
  pkgBoost: {
    dropper: parseFloat(process.env.PAIR_PKG_DROPPER || '2.0'),
    pouch: parseFloat(process.env.PAIR_PKG_POUCH || '1.5'),
    bottle: parseFloat(process.env.PAIR_PKG_BOTTLE || '1.0')
  },
  
  // Extras (multi-image products)
  extras: {
    maxPerProduct: parseInt(process.env.PAIR_EXTRAS_MAX || '4', 10),
    minScore: parseFloat(process.env.PAIR_EXTRAS_MIN_SCORE || '2')
  },
  
  // Batch limits (rate limiting & performance)
  batch: {
    maxPerChunk: parseInt(process.env.PAIR_BATCH_MAX_CHUNK || '200', 10),
    maxWallMs: parseInt(process.env.PAIR_BATCH_MAX_WALL_MS || '30000', 10)
  },
  
  // Safety limits
  maxCandidateBuildMs: parseInt(process.env.PAIR_MAX_BUILD_MS || '30000', 10), // 30s
  maxBackFrontRatio: parseInt(process.env.PAIR_MAX_BACK_FRONT_RATIO || '3', 10), // warn if back appears under 3+ fronts
  
  // Cost guardrails
  disableTiebreak: process.env.PAIR_DISABLE_TIEBREAK === '1',
  maxModelRetries: parseInt(process.env.PAIR_MAX_MODEL_RETRIES || '3', 10),
  maxTextChars: parseInt(process.env.PAIR_MAX_TEXT_CHARS || '1500', 10),
  
  // Model config
  model: process.env.PAIR_MODEL || 'gpt-4o-mini',
  temperature: parseFloat(process.env.PAIR_TEMPERATURE || '0'),
  
  // SLO targets (for monitoring)
  slo: {
    pairRate: parseFloat(process.env.PAIR_SLO_PAIR_RATE || '98'),
    maxSingletonRate: parseFloat(process.env.PAIR_SLO_MAX_SINGLETON_RATE || '2'),
    maxGptRate: parseFloat(process.env.PAIR_SLO_MAX_GPT_RATE || '2'),
    targetRuntimeMs: parseInt(process.env.PAIR_SLO_TARGET_RUNTIME_MS || '75', 10)
  }
};

export function getThresholdsSnapshot() {
  return {
    engineVersion: ENGINE_VERSION,
    minPreScore: cfg.minPreScore,
    autoPairScore: cfg.autoPair.score,
    autoPairGap: cfg.autoPair.gap,
    autoPairHairScore: cfg.autoPairHair.score,
    autoPairHairGap: cfg.autoPairHair.gap
  };
}
