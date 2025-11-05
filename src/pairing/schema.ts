// Copilot: Create a Zod schema and TS types for the pairing output.
// Export parsePairingResult(json: unknown): PairingResult that throws on invalid.

import { z } from "zod";

const Pair = z.object({
  frontUrl: z.string().min(1),
  backUrl: z.string().min(1),
  matchScore: z.number(),
  brand: z.string(),
  product: z.string(),
  variant: z.string().nullable(),
  sizeFront: z.string().nullable(),
  sizeBack: z.string().nullable(),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1)
});

const ProductGroup = z.object({
  productId: z.string().min(1),
  frontUrl: z.string().min(1),
  backUrl: z.string().min(1),
  heroDisplayUrl: z.string().optional(), // Display URL for front image
  backDisplayUrl: z.string().optional(), // Display URL for back image
  extras: z.array(z.string()).default([]), // side/detail/angle images
  evidence: z.object({
    brand: z.string(),
    product: z.string(),
    variant: z.string().nullable(),
    matchScore: z.number(),
    confidence: z.number().min(0).max(1),
    triggers: z.array(z.string()).default([])
  })
});

const Singleton = z.object({
  url: z.string().min(1),
  reason: z.string().min(1)
});

export const PairingResultSchema = z.object({
  engineVersion: z.string().optional(), // Tracks pairing system version
  pairs: z.array(Pair).default([]),
  products: z.array(ProductGroup).default([]), // multi-image products
  singletons: z.array(Singleton).default([]),
  debugSummary: z.array(z.string()).default([])
});

export type PairingResult = z.infer<typeof PairingResultSchema>;
export type Pair = z.infer<typeof Pair>;
export type ProductGroup = z.infer<typeof ProductGroup>;
export type Singleton = z.infer<typeof Singleton>;

export function parsePairingResult(input: unknown): PairingResult {
  return PairingResultSchema.parse(input);
}
