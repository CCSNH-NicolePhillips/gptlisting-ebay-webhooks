/**
 * DEPRECATED: Legacy Express service - NOT USED
 * All functionality has been migrated to Netlify Functions.
 * Commented out to reduce memory footprint.
 * 
 * @deprecated Since migration to Netlify Functions
 * @see src/smartdrafts/ for current listing enrichment
 */

// Stub exports to prevent import errors in tests
export interface ProductGroup { sku: string; }
export const enrichListingWithAI = async () => ({});
