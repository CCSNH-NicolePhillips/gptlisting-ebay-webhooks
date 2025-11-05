// Validate:
// - front vs back role gating
// - brand equality boosts
// - size equality boosts
// - packaging equality boosts
// - K truncation and score threshold ≥ 2

import { buildCandidates } from "../../src/pairing/candidates.js";
import type { FeatureRow } from "../../src/pairing/featurePrep.js";

test("role gating: only front-back pairs considered", () => {
  const features = new Map<string, FeatureRow>([
    ["front1.jpg", {
      url: "front1.jpg",
      role: "front",
      brandNorm: "brand",
      productTokens: ["test", "product"],
      variantTokens: [],
      sizeCanonical: "100ml",
      packagingHint: "bottle",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["back1.jpg", {
      url: "back1.jpg",
      role: "back",
      brandNorm: "brand",
      productTokens: ["test", "product"],
      variantTokens: [],
      sizeCanonical: "100ml",
      packagingHint: "bottle",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["other.jpg", {
      url: "other.jpg",
      role: "other",
      brandNorm: "brand",
      productTokens: ["test", "product"],
      variantTokens: [],
      sizeCanonical: "100ml",
      packagingHint: "bottle",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }]
  ]);
  
  const candidates = buildCandidates(features, 4);
  
  expect(candidates["front1.jpg"]).toBeDefined();
  expect(candidates["front1.jpg"].length).toBeGreaterThan(0);
  expect(candidates["other.jpg"]).toBeUndefined();
});

test("brand match boosts score by 3", () => {
  const features = new Map<string, FeatureRow>([
    ["front.jpg", {
      url: "front.jpg",
      role: "front",
      brandNorm: "testbrand",
      productTokens: ["product"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "other",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["back1.jpg", {
      url: "back1.jpg",
      role: "back",
      brandNorm: "testbrand",
      productTokens: ["product"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "other",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["back2.jpg", {
      url: "back2.jpg",
      role: "back",
      brandNorm: "otherbrand",
      productTokens: ["product"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "other",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }]
  ]);
  
  const candidates = buildCandidates(features, 4);
  
  const cand1 = candidates["front.jpg"].find(c => c.backUrl === "back1.jpg");
  const cand2 = candidates["front.jpg"].find(c => c.backUrl === "back2.jpg");
  
  expect(cand1).toBeDefined();
  expect(cand2).toBeDefined();
  expect(cand1!.score).toBeGreaterThan(cand2!.score);
  expect(cand1!.brandMatch).toBe(true);
  expect(cand2!.brandMatch).toBe(false);
});

test("size equality boosts score by 1", () => {
  const features = new Map<string, FeatureRow>([
    ["front.jpg", {
      url: "front.jpg",
      role: "front",
      brandNorm: "brand",
      productTokens: ["test"],
      variantTokens: [],
      sizeCanonical: "100ml",
      packagingHint: "other",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["back1.jpg", {
      url: "back1.jpg",
      role: "back",
      brandNorm: "brand",
      productTokens: ["test"],
      variantTokens: [],
      sizeCanonical: "100ml",
      packagingHint: "other",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["back2.jpg", {
      url: "back2.jpg",
      role: "back",
      brandNorm: "brand",
      productTokens: ["test"],
      variantTokens: [],
      sizeCanonical: "200ml",
      packagingHint: "other",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }]
  ]);
  
  const candidates = buildCandidates(features, 4);
  
  const cand1 = candidates["front.jpg"].find(c => c.backUrl === "back1.jpg");
  const cand2 = candidates["front.jpg"].find(c => c.backUrl === "back2.jpg");
  
  expect(cand1!.sizeEq).toBe(true);
  expect(cand2!.sizeEq).toBe(false);
  expect(cand1!.score).toBeGreaterThan(cand2!.score);
});

test("packaging match boosts score", () => {
  const features = new Map<string, FeatureRow>([
    ["front.jpg", {
      url: "front.jpg",
      role: "front",
      brandNorm: "brand",
      productTokens: ["test"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "pouch",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["back1.jpg", {
      url: "back1.jpg",
      role: "back",
      brandNorm: "brand",
      productTokens: ["test"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "pouch",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["back2.jpg", {
      url: "back2.jpg",
      role: "back",
      brandNorm: "brand",
      productTokens: ["test"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "bottle",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }]
  ]);
  
  const candidates = buildCandidates(features, 4);
  
  const cand1 = candidates["front.jpg"].find(c => c.backUrl === "back1.jpg");
  const cand2 = candidates["front.jpg"].find(c => c.backUrl === "back2.jpg");
  
  expect(cand1!.pkgMatch).toBe(true);
  expect(cand2!.pkgMatch).toBe(false);
});

test("score threshold >= 2 filters candidates", () => {
  const features = new Map<string, FeatureRow>([
    ["front.jpg", {
      url: "front.jpg",
      role: "front",
      brandNorm: "brand1",
      productTokens: ["unique"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "other",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ["back1.jpg", {
      url: "back1.jpg",
      role: "back",
      brandNorm: "brand2",
      productTokens: ["different"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "other",
      categoryPath: "Cosmetics",
      categoryTail: "Cosmetics",
      hasText: true,
      colorKey: "red", textExtracted: ""
    }]
  ]);
  
  const candidates = buildCandidates(features, 4);
  
  // Should have no candidates due to low score
  expect(candidates["front.jpg"]).toBeUndefined();
});

test("K truncation limits candidates", () => {
  const features = new Map<string, FeatureRow>([
    ["front.jpg", {
      url: "front.jpg",
      role: "front",
      brandNorm: "brand",
      productTokens: ["test"],
      variantTokens: [],
      sizeCanonical: null,
      packagingHint: "bottle",
      categoryPath: "Health",
      categoryTail: "Health",
      hasText: true,
      colorKey: "blue", textExtracted: ""
    }],
    ...Array.from({ length: 10 }, (_, i) => [
      `back${i}.jpg`,
      {
        url: `back${i}.jpg`,
        role: "back" as const,
        brandNorm: "brand",
        productTokens: ["test"],
        variantTokens: [],
        sizeCanonical: null,
        packagingHint: "bottle",
        categoryPath: "Health",
        categoryTail: "Health",
        hasText: true,
        colorKey: "blue", textExtracted: ""
      }
    ] as [string, FeatureRow])
  ]);
  
  const candidates = buildCandidates(features, 3);
  
  expect(candidates["front.jpg"].length).toBeLessThanOrEqual(3);
});
