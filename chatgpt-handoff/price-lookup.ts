import { extractPriceFromHtml } from "./html-price.js";
import { braveFirstUrlForBrandSite } from "./search.js";
import { getBrandUrls } from "./brand-map.js";
import { fetchSoldPriceStats, type SoldPriceStats } from "./pricing/ebay-sold-prices.js";
import { openai } from "./openai.js";

// ============================================================================
// NEW TIERED PRICING ENGINE
// ============================================================================

export interface PriceLookupInput {
  title: string;
  brand?: string;
  brandWebsite?: string; // Official brand website URL from Vision API
  upc?: string;
  condition?: 'NEW' | 'USED' | 'OTHER';
  quantity?: number;
}

export type PriceSource = 'ebay-sold' | 'brand-msrp' | 'brave-fallback' | 'estimate';

export interface PriceSourceDetail {
  source: PriceSource;
  price: number;
  currency: string;
  url?: string;
  notes?: string;
}

export interface PriceDecision {
  ok: boolean;
  chosen?: PriceSourceDetail;
  candidates: PriceSourceDetail[];
  recommendedListingPrice?: number;
  reason?: string;
}

// ... rest of the file continues (see actual file for full implementation)
// This is a COPY for ChatGPT reference - see README.md for problem description
