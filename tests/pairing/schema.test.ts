// Copilot: Write a Jest test that validates a small mock pairing payload passes,
// and that missing required fields throws.

import { parsePairingResult } from "../../src/pairing/schema.js";

test("valid pairing parses", () => {
  const ok = parsePairingResult({
    pairs: [{
      frontUrl: "a.jpg",
      backUrl: "b.jpg",
      matchScore: 2.7,
      brand: "frog fuel",
      product: "performance greens + protein",
      variant: "lemon lime",
      sizeFront: "720g",
      sizeBack: "720g",
      evidence: ["productNameSimilarity: 0.92"],
      confidence: 0.77
    }],
    singletons: [{ url: "c.jpg", reason: "no candidate ≥ 2.0" }],
    debugSummary: []
  });
  expect(ok.pairs.length).toBe(1);
});

test("invalid pairing throws", () => {
  expect(() => parsePairingResult({ pairs: [{}] })).toThrow();
});
