/**
 * DEPRECATED: Legacy Express service - NOT USED
 * All functionality has been migrated to Netlify Functions.
 * Commented out to reduce memory footprint.
 * 
 * @deprecated Since migration to Netlify Functions
 * @see src/lib/ebay-adapter.ts for current eBay adapter
 * @see src/lib/ebay-auth.ts for current auth handling
 * @see netlify/functions/ebay-* for current implementation
 */

// Stub exports to prevent import errors in tests
export const buildEbayAuthUrl = () => '';
export const exchangeAuthCode = async () => ({});
export const saveEbayTokens = async () => {};
export const getAccessToken = async () => '';
export const ensureInventoryItem = async () => {};
export const createOffer = async () => ({ offerId: '' });
export const publishOffer = async () => {};
export const ensureEbayPrereqs = async () => ({ paymentPolicyId: '', returnPolicyId: '', fulfillmentPolicyId: '', merchantLocationKey: '' });
export const whoAmI = async () => ({});
export const listPolicies = async () => ({});
export const listInventoryLocations = async () => ({});
