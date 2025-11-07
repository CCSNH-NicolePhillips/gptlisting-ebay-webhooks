import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";

const METHODS = "POST, OPTIONS";
const DEFAULT_MARKETPLACE = process.env.DEFAULT_MARKETPLACE_ID || "EBAY_US";
const DEFAULT_CATEGORY = process.env.DEFAULT_CATEGORY_ID || "11116";
const DEFAULT_QUANTITY = 1;

function conditionStringToCode(value: string): number {
  const upper = value.toUpperCase().trim();
  if (upper === "NEW") return 1000;
  if (upper === "LIKE_NEW") return 1500;
  if (upper === "USED_EXCELLENT" || upper === "EXCELLENT") return 2000;
  if (upper === "USED_GOOD" || upper === "GOOD") return 2500;
  if (upper === "USED_ACCEPTABLE" || upper === "ACCEPTABLE") return 3000;
  return 1000; // Default to NEW
}

type ChatGptDraft = {
  productId: string;
  brand: string;
  product: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, string[]>;
  category: { id: string; title: string };
  images: string[];
  price: number;
  condition: string;
};

type EbayDraftInput = {
  jobId: string;
  drafts: ChatGptDraft[];
};

function generateSku(draft: ChatGptDraft, index: number): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 7);
  const prefix = draft.brand?.substring(0, 3).toUpperCase() || "ITM";
  return `${prefix}-${timestamp}-${random}-${index}`;
}

function conditionCodeToNumber(conditionStr: string): number {
  return conditionStringToCode(conditionStr);
}

function formatDescription(draft: ChatGptDraft): string {
  let desc = draft.description;
  
  if (draft.bullets && draft.bullets.length > 0) {
    desc += "\n\nFeatures:\n";
    draft.bullets.forEach(bullet => {
      desc += `• ${bullet}\n`;
    });
  }
  
  return desc.trim();
}

/**
 * Convert ChatGPT draft to eBay TaxonomyMappedDraft format
 */
function convertToEbayDraft(draft: ChatGptDraft, index: number) {
  const sku = generateSku(draft, index);
  const categoryId = draft.category?.id || DEFAULT_CATEGORY;
  const marketplaceId = DEFAULT_MARKETPLACE;
  const conditionStr = draft.condition || "NEW";
  const conditionCode = conditionCodeToNumber(conditionStr);
  const description = formatDescription(draft);
  
  return {
    sku,
    inventory: {
      condition: conditionStr,
      product: {
        title: draft.title,
        description,
        imageUrls: draft.images,
        aspects: draft.aspects,
      },
    },
    offer: {
      sku,
      marketplaceId,
      categoryId,
      price: draft.price,
      quantity: DEFAULT_QUANTITY,
      condition: conditionCode,
      fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID || null,
      paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID || null,
      returnPolicyId: process.env.EBAY_RETURN_POLICY_ID || null,
      merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY || null,
      description,
    },
    _meta: {
      selectedCategory: draft.category?.id 
        ? { 
            id: draft.category.id, 
            slug: draft.category.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            title: draft.category.title 
          } 
        : null,
      missingRequired: [],
      marketplaceId,
      categoryId,
      price: draft.price,
      source: "smartdrafts-chatgpt",
      productId: draft.productId,
    },
  };
}

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, null, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  try {
    // Authenticate user
    await requireUserAuth(headers.authorization || headers.Authorization);
    
    // Parse request body
    const body: EbayDraftInput = JSON.parse(event.body || "{}");
    
    if (!body.jobId) {
      return jsonResponse(400, { ok: false, error: "jobId required" }, originHdr, METHODS);
    }
    
    if (!Array.isArray(body.drafts) || body.drafts.length === 0) {
      return jsonResponse(400, { ok: false, error: "drafts array required" }, originHdr, METHODS);
    }
    
    // Convert ChatGPT drafts to eBay format
    const ebayDrafts = body.drafts.map((draft, index) => convertToEbayDraft(draft, index));
    
    // Return converted drafts
    // These can now be sent to create-ebay-draft-user endpoint
    return jsonResponse(
      200,
      {
        ok: true,
        groups: ebayDrafts,
        count: ebayDrafts.length,
        jobId: body.jobId,
      },
      originHdr,
      METHODS
    );
    
  } catch (error: any) {
    console.error("[smartdrafts-save-drafts]", error);
    return jsonResponse(
      500,
      {
        ok: false,
        error: error.message || "Internal server error",
      },
      originHdr,
      METHODS
    );
  }
};
