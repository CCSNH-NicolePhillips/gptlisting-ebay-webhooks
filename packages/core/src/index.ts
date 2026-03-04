/**
 * @core — platform-agnostic business logic barrel
 *
 * Prefer importing from sub-paths (e.g. `@core/pricing/index.js`) for
 * tree-shaking.  This barrel exists for convenience and IDE discoverability.
 */

// Pricing pipeline
export * from './pricing/index.js';

// Job lifecycle helpers
export * from './jobs/job-status.js';

// Shipping estimates
export * from './shipping/shipping-estimates.js';

// Carrier rate tables (domestic + international)
export * from './shipping/carrier-rates.js';

// Net-weight → shipping-weight converter
export * from './shipping/shipping-weight.js';
