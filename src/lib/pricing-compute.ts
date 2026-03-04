/**
 * @deprecated All exports have moved to src/lib/pricing/.
 *
 *   Dependency-free pure math:  src/lib/pricing/ebay-price-math.ts
 *   Config-dependent helpers:   src/lib/pricing/legacy-compute.ts
 *
 * This file is kept as a backward-compatibility re-export stub so that
 * existing tests that reference pricing-compute.ts continue to pass without
 * modification.  Production app code must NOT import from this file —
 * use src/lib/pricing/index.ts (for getPricingDecision) or the sub-modules
 * above for raw helpers.
 *
 * CI enforcement: scripts/check-forbidden-imports.ps1 will fail if
 * src/ or netlify/functions/ contain direct imports of this file.
 */

// Dependency-free pure math (no imports from project modules)
export * from './pricing/ebay-price-math.js';

// Config-dependent helpers (imports from pricing-config + ebay-price-math)
export * from './pricing/legacy-compute.js';
