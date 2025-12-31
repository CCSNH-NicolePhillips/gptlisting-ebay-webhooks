/**
 * DEPRECATED: Legacy v1 direct pairing jobs - NOT USED
 * Superseded by pairingV2Jobs.ts
 * Commented out to reduce memory footprint.
 * 
 * @deprecated Use src/lib/pairingV2Jobs.ts instead
 * @see src/lib/pairingV2Jobs.ts for current job management
 */

// Stub exports to prevent import errors in tests
export const scheduleDirectPairingJob = async () => ({ jobId: '' });
export const getDirectPairingJobStatus = async () => ({ state: 'complete' as const, result: { products: [] } });
