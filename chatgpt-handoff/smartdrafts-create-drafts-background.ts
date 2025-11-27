import type { Handler } from "@netlify/functions";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";

// Import the draft creation logic from the existing function
import OpenAI from "openai";
import { pickCategoryForGroup } from "../../src/lib/taxonomy-select.js";
import { listCategories } from "../../src/lib/taxonomy-store.js";
import { lookupPrice, type PriceLookupInput, type PriceDecision } from "../../src/lib/price-lookup.js";

const GPT_TIMEOUT_MS = 30_000;
const GPT_RETRY_ATTEMPTS = 2;
const GPT_RETRY_DELAY_MS = 1000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// Cache categories in memory for the lifetime of this function instance
let categoriesCache: any[] | null = null;
let categoriesLoadingPromise: Promise<any[]> | null = null;

type BackgroundPayload = {
  jobId?: string;
  userId?: string;
  products?: any[];
};

type PairedProduct = {
  productId: string;
  brand: string;
  product: string;
  title?: string; // For books: the actual book title (brand will be null, product is author)
  brandWebsite?: string; // Official brand website URL from Vision API
  variant?: string;
  size?: string;
  categoryPath?: string;
  keyText?: string[]; // Key text snippets from product packaging (from Vision API)
  heroDisplayUrl?: string;
  backDisplayUrl?: string;
  extras?: string[];
  evidence?: string[];
};

type CategoryHint = {
  id: string;
  title: string;
  aspects: Record<string, any>;
};

type Draft = {
  productId: string;
  groupId: string; // For eBay publishing via create-ebay-draft-user
  brand: string;
  product: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, string[]>;
  category: CategoryHint;
  images: string[];
  price: number | null;
  condition: string;
  pricingStatus?: 'OK' | 'NEEDS_REVIEW';
  priceMeta?: {
    chosenSource?: string;
    basePrice?: number;
    candidates?: any[];
  };
};

// ... rest of the file continues (see actual file for full implementation)
// This is a COPY for ChatGPT reference - see README.md for problem description
