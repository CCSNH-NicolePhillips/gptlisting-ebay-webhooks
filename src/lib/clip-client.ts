/**
 * DEPRECATED: Legacy CLIP client - NOT USED
 * Superseded by clip-client-split.ts which uses separate text/image endpoints.
 * Commented out to reduce memory footprint.
 * 
 * @deprecated Use src/lib/clip-client-split.ts instead
 * @see src/lib/clip-client-split.ts for current CLIP implementation
 * @see src/lib/clip-provider.ts for provider abstraction
 */

// Stub exports to prevent import errors in tests
export const cosine = (a: number[] | null, b: number[] | null): number => {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};
export const clipTextEmbedding = async (): Promise<number[] | null> => null;
export const clipImageEmbedding = async (): Promise<number[] | null> => null;
export const clipProviderInfo = (): { hf: boolean; jina: boolean; openai: boolean } => ({ hf: false, jina: false, openai: false });
