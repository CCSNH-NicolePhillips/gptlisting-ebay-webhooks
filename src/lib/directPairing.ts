/**
 * DEPRECATED: Legacy v1 direct pairing - NOT USED
 * Superseded by pairing-v2-core.ts and pairingV2Jobs.ts
 * Commented out to reduce memory footprint.
 * 
 * @deprecated Use src/smartdrafts/pairing-v2-core.ts instead
 * @see src/smartdrafts/pairing-v2-core.ts for current pairing logic
 * @see src/lib/pairingV2Jobs.ts for current job management
 */

// Stub exports to prevent import errors in tests
export type DirectPairProduct = { productName: string; frontImage: string; backImage: string; };
export type DirectPairsResult = { products: DirectPairProduct[]; };
export type DirectPairImageInput = { url: string; filename: string; };
export const directPairProductsFromImages = async (): Promise<DirectPairsResult> => ({ products: [] });
