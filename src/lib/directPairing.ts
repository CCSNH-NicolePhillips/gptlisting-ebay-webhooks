// Direct Pairing Phase DP1: One-shot multimodal GPT-4o pairing
// Sends all images to GPT-4o in a single request to get product pairs

import OpenAI from "openai";

export type DirectPairProduct = {
  productName: string;
  frontImage: string;
  backImage: string;
};

export type DirectPairsResult = {
  products: DirectPairProduct[];
};

export type DirectPairImageInput = {
  url: string;      // full URL used by Vision (S3/Dropbox/proxy)
  filename: string; // e.g. "20251115_142814.jpg"
};

export async function directPairProductsFromImages(
  images: DirectPairImageInput[]
): Promise<DirectPairsResult> {
  // Guard: empty input
  if (images.length === 0) {
    return { products: [] };
  }

  // Batch processing to avoid timeouts with large image sets
  // Process in batches of 12 images (24 content blocks) to stay under timeout
  const BATCH_SIZE = 12;
  const allProducts: DirectPairProduct[] = [];

  console.log("[directPairing] Processing", {
    totalImages: images.length,
    batchSize: BATCH_SIZE,
    batches: Math.ceil(images.length / BATCH_SIZE),
  });

  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(images.length / BATCH_SIZE);
    
    console.log(`[directPairing] Processing batch ${batchNum}/${totalBatches} (${batch.length} images)`);
    
    const batchResult = await processSingleBatch(batch);
    allProducts.push(...batchResult.products);
    
    console.log(`[directPairing] Batch ${batchNum}/${totalBatches} complete: ${batchResult.products.length} products`);
  }

  console.log("[directPairing] All batches complete:", {
    totalProducts: allProducts.length,
  });

  return { products: allProducts };
}

async function processSingleBatch(
  images: DirectPairImageInput[]
): Promise<DirectPairsResult> {
  // Create OpenAI client (reuse env var like scan does)
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
  });

  // Build system message
  const systemMessage = 
    "You are an assistant that pairs product front and back images. " +
    "Each product has exactly two images: one front and one back. " +
    "Use the image content plus the file names to decide front vs back and which images belong together. " +
    "Return strict JSON with an array of products. Never invent filenames; only use the ones provided.";

  // Build user message with all images
  const content: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [];

  content.push({
    type: "text",
    text:
      "Here are the product photos. Each product has exactly 2 images: one front and one back. " +
      "Use the image content plus the file names to decide front vs back and which images belong together. " +
      "Return strict JSON. Do not describe the images, just identify the pairs.",
  });

  for (const img of images) {
    content.push({
      type: "text",
      text: `Image: ${img.filename}`,
    });
    content.push({
      type: "image_url",
      image_url: { 
        url: img.url,
        detail: "auto" // Let GPT-4o decide detail level based on image content
      },
    });
  }

  // Call GPT-4o with JSON schema response format
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: systemMessage,
      },
      {
        role: "user",
        content: content as any,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "direct_pairs",
        schema: {
          type: "object",
          properties: {
            products: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  productName: { type: "string" },
                  frontImage: { type: "string" },
                  backImage: { type: "string" },
                },
                required: ["productName", "frontImage", "backImage"],
                additionalProperties: false,
              },
            },
          },
          required: ["products"],
          additionalProperties: false,
        },
      },
    },
    temperature: 0,
  });

  // Parse the JSON response
  const rawContent = response.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error("[directPairing] No content in GPT-4o response");
  }

  const result = JSON.parse(rawContent) as DirectPairsResult;

  // Validate filenames
  const validFilenames = new Set(images.map(img => img.filename));
  const validProducts = result.products.filter(p => {
    const frontValid = validFilenames.has(p.frontImage);
    const backValid = validFilenames.has(p.backImage);
    if (!frontValid || !backValid) {
      console.warn("[directPairing] Invalid filename in product:", p);
      return false;
    }
    return true;
  });

  console.log("[directPairing] Result products:", validProducts.length);

  return { products: validProducts };
}
