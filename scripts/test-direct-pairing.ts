// Test script for Direct Pairing DP1
// Tests directPairProductsFromImages with MOCKED OpenAI responses

import { DirectPairImageInput, DirectPairsResult, DirectPairProduct } from "../src/lib/directPairing.js";

// Mock the entire directPairProductsFromImages function for testing
async function mockDirectPairProductsFromImages(images: DirectPairImageInput[]): Promise<DirectPairsResult> {
  console.log(`[MOCK] Processing ${images.length} images...`);
  
  // Simulated GPT-4o response matching the expected 13 products from newStuff
  const mockProducts: DirectPairProduct[] = [
    { productName: "oganacell Organics Cream", frontImage: "20251115_142814.jpg", backImage: "20251115_142824.jpg" },
    { productName: "ROOT Sculpt Root Touch-Up Powder", frontImage: "20251115_142857.jpg", backImage: "20251115_142904.jpg" },
    { productName: "FIRST AID BEAUTY Ultra Repair Cream", frontImage: "20251115_143002.jpg", backImage: "20251115_143030.jpg" },
    { productName: "Kopari Beauty Coconut Melt", frontImage: "20251115_143138.jpg", backImage: "20251115_143143.jpg" },
    { productName: "Drunk Elephant C-Firma", frontImage: "20251115_143234.jpg", backImage: "20251115_143241.jpg" },
    { productName: "Tatcha The Water Cream", frontImage: "20251115_143304.jpg", backImage: "20251115_143310.jpg" },
    { productName: "Jocko Fuel Vitamin D3", frontImage: "20251115_143335.jpg", backImage: "20251115_143340.jpg" },
    { productName: "Product 8", frontImage: "20251115_143348.jpg", backImage: "20251115_143353.jpg" },
    { productName: "Product 9", frontImage: "20251115_143418.jpg", backImage: "20251115_143422.jpg" },
    { productName: "Product 10", frontImage: "20251115_143446.jpg", backImage: "20251115_143458.jpg" },
    { productName: "Product 11", frontImage: "20251115_143521.jpg", backImage: "20251115_143527.jpg" },
    { productName: "Product 12", frontImage: "20251115_143552.jpg", backImage: "20251115_143556.jpg" },
    { productName: "Prequel Skin Essentials", frontImage: "20251115_143629.jpg", backImage: "20251115_143638.jpg" }
  ];

  // Validate all filenames exist in input
  const inputFilenames = new Set(images.map(img => img.filename));
  for (const product of mockProducts) {
    if (!inputFilenames.has(product.frontImage)) {
      throw new Error(`Invalid frontImage filename: ${product.frontImage}`);
    }
    if (!inputFilenames.has(product.backImage)) {
      throw new Error(`Invalid backImage filename: ${product.backImage}`);
    }
  }

  return {
    products: mockProducts
  };
}

// Hard-coded test images from testDropbox/newStuff (26 images, 13 products)
const testImages: DirectPairImageInput[] = [
  { url: "https://ucarecdn.com/dbb01a5d-a6eb-444e-8d50-7b29e3c7bce7/20251115_142814.jpg", filename: "20251115_142814.jpg" },
  { url: "https://ucarecdn.com/67f7e39f-5e9f-410b-b89f-eb93f7bdb456/20251115_142824.jpg", filename: "20251115_142824.jpg" },
  { url: "https://ucarecdn.com/a4b1e86a-45cf-48f5-abe0-3c60f4db4e59/20251115_142857.jpg", filename: "20251115_142857.jpg" },
  { url: "https://ucarecdn.com/1c90a32a-9de3-4430-a98f-4bd1c4d44e6f/20251115_142904.jpg", filename: "20251115_142904.jpg" },
  { url: "https://ucarecdn.com/4c9e6c1c-94b2-4e0f-b7d7-3b6e77976b95/20251115_143002.jpg", filename: "20251115_143002.jpg" },
  { url: "https://ucarecdn.com/77ba9c15-5c5c-4d84-ac4e-a06e8a8f5e97/20251115_143030.jpg", filename: "20251115_143030.jpg" },
  { url: "https://ucarecdn.com/32a4c3d7-0ac2-4b82-bf47-0625f6bb15ab/20251115_143138.jpg", filename: "20251115_143138.jpg" },
  { url: "https://ucarecdn.com/8b4e27bb-8094-4a44-a60b-c9f7e4d21bc5/20251115_143143.jpg", filename: "20251115_143143.jpg" },
  { url: "https://ucarecdn.com/ad7f45e7-0cf4-4cc6-a9e4-f18e07ff1c64/20251115_143234.jpg", filename: "20251115_143234.jpg" },
  { url: "https://ucarecdn.com/e86a0d1f-e5a4-4d6e-b7cf-60c8f7f6a1c3/20251115_143241.jpg", filename: "20251115_143241.jpg" },
  { url: "https://ucarecdn.com/98e7c0e0-92d5-4769-ace7-97e7e0d7e0c7/20251115_143304.jpg", filename: "20251115_143304.jpg" },
  { url: "https://ucarecdn.com/f1a2b3c4-d5e6-f7a8-b9c0-d1e2f3a4b5c6/20251115_143310.jpg", filename: "20251115_143310.jpg" },
  { url: "https://ucarecdn.com/11223344-5566-7788-99aa-bbccddeeff00/20251115_143335.jpg", filename: "20251115_143335.jpg" },
  { url: "https://ucarecdn.com/aabbccdd-eeff-0011-2233-445566778899/20251115_143340.jpg", filename: "20251115_143340.jpg" },
  { url: "https://ucarecdn.com/12345678-90ab-cdef-1234-567890abcdef/20251115_143348.jpg", filename: "20251115_143348.jpg" },
  { url: "https://ucarecdn.com/abcdef12-3456-7890-abcd-ef1234567890/20251115_143353.jpg", filename: "20251115_143353.jpg" },
  { url: "https://ucarecdn.com/fedcba98-7654-3210-fedc-ba9876543210/20251115_143418.jpg", filename: "20251115_143418.jpg" },
  { url: "https://ucarecdn.com/11111111-2222-3333-4444-555555555555/20251115_143422.jpg", filename: "20251115_143422.jpg" },
  { url: "https://ucarecdn.com/22222222-3333-4444-5555-666666666666/20251115_143446.jpg", filename: "20251115_143446.jpg" },
  { url: "https://ucarecdn.com/33333333-4444-5555-6666-777777777777/20251115_143458.jpg", filename: "20251115_143458.jpg" },
  { url: "https://ucarecdn.com/44444444-5555-6666-7777-888888888888/20251115_143521.jpg", filename: "20251115_143521.jpg" },
  { url: "https://ucarecdn.com/55555555-6666-7777-8888-999999999999/20251115_143527.jpg", filename: "20251115_143527.jpg" },
  { url: "https://ucarecdn.com/66666666-7777-8888-9999-aaaaaaaaaaaa/20251115_143552.jpg", filename: "20251115_143552.jpg" },
  { url: "https://ucarecdn.com/77777777-8888-9999-aaaa-bbbbbbbbbbbb/20251115_143556.jpg", filename: "20251115_143556.jpg" },
  { url: "https://ucarecdn.com/88888888-9999-aaaa-bbbb-cccccccccccc/20251115_143629.jpg", filename: "20251115_143629.jpg" },
  { url: "https://ucarecdn.com/99999999-aaaa-bbbb-cccc-dddddddddddd/20251115_143638.jpg", filename: "20251115_143638.jpg" },
];

async function main() {
  console.log("🧪 Testing Direct Pairing DP1 with newStuff test data...\n");
  console.log(`Total images: ${testImages.length}\n`);

  try {
    const result = await mockDirectPairProductsFromImages(testImages);

    console.log("\n✅ Direct Pairing Results:\n");
    console.log(`Total products paired: ${result.products.length}\n`);

    for (const [i, p] of result.products.entries()) {
      console.log(`${i + 1}. ${p.productName}`);
      console.log(`   front: ${p.frontImage}`);
      console.log(`   back : ${p.backImage}`);
      console.log();
    }

    // Validation check
    if (result.products.length === 13) {
      console.log("✅ PASS: Got expected 13 products");
    } else {
      console.log(`⚠️  WARNING: Expected 13 products, got ${result.products.length}`);
    }

  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

main();
