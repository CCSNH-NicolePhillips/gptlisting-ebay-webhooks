// Validate deterministic feature extraction:
// - brandNorm normalizes "R+Co" & "myBrainCo."
// - sizeCanonical converts 1.4 fl oz -> 41ml, 25.4 oz -> 720g when categoryPath suggests it
// - packagingHint picks 'pouch' for resealable pouch, 'dropper-bottle' for droppers
// - categoryTail extracts the last 1–2 nodes

import { buildFeatures } from "../../src/pairing/featurePrep.js";

test("brandNorm normalizes correctly", () => {
  const analysis = {
    groups: [
      { brand: "R+Co", product: "Hair Oil", primaryImageUrl: "a.jpg", categoryPath: "Beauty > Hair Care" },
      { brand: "myBrainCo.", product: "Gut Repair", primaryImageUrl: "b.jpg", categoryPath: "Health" }
    ],
    imageInsights: [
      { url: "a.jpg", role: "front", hasVisibleText: true, dominantColor: "lavender", visualDescription: "bottle" },
      { url: "b.jpg", role: "front", hasVisibleText: true, dominantColor: "black", visualDescription: "pouch" }
    ]
  };
  
  const features = buildFeatures(analysis);
  
  expect(features.get("a.jpg")?.brandNorm).toBe("r co");
  expect(features.get("b.jpg")?.brandNorm).toBe("mybrainco");
});

test("sizeCanonical converts fl oz to ml for supplements", () => {
  const analysis = {
    groups: [
      { brand: "Test", product: "Product", size: "1.4 fl oz", primaryImageUrl: "a.jpg", categoryPath: "Health & Wellness > Supplements" }
    ],
    imageInsights: [
      { url: "a.jpg", role: "front", hasVisibleText: true, dominantColor: "blue", visualDescription: "bottle" }
    ]
  };
  
  const features = buildFeatures(analysis);
  
  expect(features.get("a.jpg")?.sizeCanonical).toBe("41ml");
});

test("sizeCanonical converts oz to g for supplements", () => {
  const analysis = {
    groups: [
      { brand: "Test", product: "Product", size: "25.4 oz (1.59 lb) 720 g", primaryImageUrl: "a.jpg", categoryPath: "Supplements" }
    ],
    imageInsights: [
      { url: "a.jpg", role: "front", hasVisibleText: true, dominantColor: "green", visualDescription: "pouch" }
    ]
  };
  
  const features = buildFeatures(analysis);
  
  expect(features.get("a.jpg")?.sizeCanonical).toBe("720g");
});

test("packagingHint identifies pouch from visualDescription", () => {
  const analysis = {
    groups: [
      { brand: "Test", product: "Product", primaryImageUrl: "a.jpg", categoryPath: "Health" }
    ],
    imageInsights: [
      { url: "a.jpg", role: "front", hasVisibleText: true, dominantColor: "black", visualDescription: "Black resealable pouch with a matte finish" }
    ]
  };
  
  const features = buildFeatures(analysis);
  
  expect(features.get("a.jpg")?.packagingHint).toBe("pouch");
});

test("packagingHint identifies dropper-bottle", () => {
  const analysis = {
    groups: [
      { brand: "Test", product: "Product", primaryImageUrl: "a.jpg", categoryPath: "Health" }
    ],
    imageInsights: [
      { url: "a.jpg", role: "front", hasVisibleText: true, dominantColor: "brown", visualDescription: "Brown glass dropper bottle with a pink label" }
    ]
  };
  
  const features = buildFeatures(analysis);
  
  expect(features.get("a.jpg")?.packagingHint).toBe("dropper-bottle");
});

test("categoryTail extracts last 2 nodes", () => {
  const analysis = {
    groups: [
      { brand: "Test", product: "Product", primaryImageUrl: "a.jpg", categoryPath: "Health & Wellness > Supplements > Vitamins" }
    ],
    imageInsights: [
      { url: "a.jpg", role: "front", hasVisibleText: true, dominantColor: "white", visualDescription: "bottle" }
    ]
  };
  
  const features = buildFeatures(analysis);
  
  expect(features.get("a.jpg")?.categoryTail).toBe("Supplements > Vitamins");
});

test("categoryTail handles single node", () => {
  const analysis = {
    groups: [
      { brand: "Test", product: "Product", primaryImageUrl: "a.jpg", categoryPath: "Supplements" }
    ],
    imageInsights: [
      { url: "a.jpg", role: "front", hasVisibleText: true, dominantColor: "white", visualDescription: "bottle" }
    ]
  };
  
  const features = buildFeatures(analysis);
  
  expect(features.get("a.jpg")?.categoryTail).toBe("Supplements");
});
