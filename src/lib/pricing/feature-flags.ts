/**
 * Pricing v2 Feature Flags
 * 
 * Controls safe rollout of new pricing subsystems.
 * All flags read from environment variables with sensible defaults.
 * 
 * Usage:
 *   import { pricingFlags } from './feature-flags.js';
 *   if (pricingFlags().v2Enabled) { ... }
 */

export interface PricingFeatureFlags {
  /** Enable v2 percentile-based pricing with IQR outlier rejection.
   *  When false, uses legacy floor/median targeting. */
  v2Enabled: boolean;

  /** Enable LLM-based comp matching for ambiguous identity comparisons.
   *  When false, ambiguous comps are kept (not filtered). */
  matchingLlmEnabled: boolean;

  /** Enable automatic repricing via price-tick module.
   *  When false, repricing is logged but not executed. */
  autoRepriceEnabled: boolean;

  /** Use eBay Browse API for active comps instead of Google Shopping.
   *  When false, Google Shopping is used (legacy behavior). */
  ebayBrowseActiveEnabled: boolean;

  /** Enable safety floor enforcement (min net payout model).
   *  When false, only the legacy minItemCents floor applies. */
  safetyFloorEnabled: boolean;

  /** Enable identity-based comp filtering on sold + active comps.
   *  When false, legacy title-matching only. */
  identityFilterEnabled: boolean;

  /** Enable confidence scoring with hard/soft review triggers.
   *  When false, uses legacy matchConfidence (high/medium/low). */
  confidenceScoringEnabled: boolean;
}

/**
 * Read pricing feature flags from environment variables.
 * 
 * Environment variables (all default to false for safe rollout):
 * - DP_PRICING_V2          → v2Enabled
 * - DP_MATCHING_LLM        → matchingLlmEnabled
 * - DP_AUTO_REPRICE         → autoRepriceEnabled
 * - DP_EBAY_BROWSE_ACTIVE   → ebayBrowseActiveEnabled
 * - DP_SAFETY_FLOOR         → safetyFloorEnabled
 * - DP_IDENTITY_FILTER      → identityFilterEnabled
 * - DP_CONFIDENCE_SCORING   → confidenceScoringEnabled
 */
export function pricingFlags(): PricingFeatureFlags {
  return {
    v2Enabled: envBool('DP_PRICING_V2'),
    matchingLlmEnabled: envBool('DP_MATCHING_LLM'),
    autoRepriceEnabled: envBool('DP_AUTO_REPRICE'),
    ebayBrowseActiveEnabled: envBool('DP_EBAY_BROWSE_ACTIVE'),
    safetyFloorEnabled: envBool('DP_SAFETY_FLOOR'),
    identityFilterEnabled: envBool('DP_IDENTITY_FILTER'),
    confidenceScoringEnabled: envBool('DP_CONFIDENCE_SCORING'),
  };
}

/**
 * Quick check: is the v2 pricing engine active?
 */
export function isV2Active(): boolean {
  return envBool('DP_PRICING_V2');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envBool(name: string): boolean {
  const val = process.env[name];
  if (!val) return false;
  return val === 'true' || val === '1' || val === 'yes';
}
