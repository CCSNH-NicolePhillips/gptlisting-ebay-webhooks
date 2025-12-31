/**
 * DEPRECATED: Legacy Express service - NOT USED
 * All functionality has been migrated to Netlify Functions.
 * Commented out to reduce memory footprint.
 * 
 * @deprecated Since migration to Netlify Functions
 * @see src/ingestion/dropbox.ts for current Dropbox adapter
 * @see netlify/functions/dropbox-* for current implementation
 */

// Stub exports to prevent import errors in tests
export const oauthStartUrl = () => '';
export const storeDropboxTokens = async () => ({});
export const listFolder = async () => ({ entries: [] });
export const getRawLink = async () => '';
