/**
 * Type definitions for eBay Marketing features
 * Including Promoted Listings and Auto Price Reduction
 */

// ============================================================================
// PROMOTED LISTINGS TYPES
// ============================================================================

export interface PromotedListingsConfig {
  enabled: boolean;
  adRate?: number; // Percentage (1-20%)
  campaignId?: string;
  adId?: string;
}

export interface PromotedListingResult {
  campaignId: string;
  adId: string;
  inventoryReferenceId: string;
  inventoryReferenceType: 'INVENTORY_ITEM' | 'INVENTORY_ITEM_GROUP';
  adRate: number;          // percentage 1–20
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'ENDED';
  createdAt?: string;      // ISO timestamp if available
  errors?: Array<{ code: string; message: string }>;
}

export interface CampaignCreateRequest {
  campaignName: string;
  marketplaceId: string;
  fundingStrategy: {
    fundingModel: 'COST_PER_SALE';
    bidPercentage: string; // "5.0" for 5%
  };
  startDate: string; // ISO 8601 format
  endDate?: string; // Optional
}

export interface AdCreateRequest {
  bidPercentage: string; // "5.0" for 5%
  inventoryReferenceId: string; // SKU
  inventoryReferenceType: 'INVENTORY_ITEM';
}

export interface PromotionStatus {
  enabled: boolean;
  adRate: number | null;
  campaignId: string | null;
  adId: string | null;
  impressions?: number;
  clicks?: number;
  sales?: number;
  adFees?: number;
}

// ============================================================================
// AUTO PRICE REDUCTION TYPES
// ============================================================================

export interface AutoPriceReductionConfig {
  enabled: boolean;
  schedule?: 'daily' | 'weekly' | 'monthly';
  reductionPercentage?: number; // 1-50%
  minPrice?: number; // Don't reduce below this
}

export interface PriceReductionSchedule {
  scheduleId: string;
  offerId: string;
  userId: string;
  schedule: 'daily' | 'weekly' | 'monthly';
  reductionPercentage: number;
  minPrice?: number;
  maxReductions?: number; // Stop after X reductions
  lastReduction?: Date;
  reductionCount: number;
  createdAt: Date;
  updatedAt: Date;
  active: boolean;
}

export interface PriceReductionExecution {
  executionId: string;
  scheduleId: string;
  offerId: string;
  userId: string;
  priceBefore: number;
  priceAfter: number;
  reductionPercentage: number;
  executedAt: Date;
  success: boolean;
  errorMessage?: string;
}

// ============================================================================
// MERCHANT DATA STRUCTURE
// ============================================================================

export interface OfferMerchantData {
  promotedListings?: PromotedListingsConfig;
  autoPriceReduction?: AutoPriceReductionConfig;
  
  // Existing fields (for reference)
  smartPriceEnabled?: boolean;
  pricingSource?: 'manual' | 'amazon' | 'ai';
  originalPrice?: number;
  
  // Additional metadata
  createdBy?: 'quick-list' | 'draft-wizard' | 'api';
  createdAt?: string;
  lastModified?: string;
}

// ============================================================================
// EXTENDED PAYLOAD TYPES
// ============================================================================

export interface ExtendedOfferCreationPayload {
  sku: string;
  marketplaceId: string;
  categoryId: string;
  price: number;
  quantity: number;
  condition?: number;
  fulfillmentPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  merchantLocationKey: string | null;
  description: string;
  
  // Marketing features stored in merchantData
  merchantData?: OfferMerchantData;
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface EbayCampaignResponse {
  campaignId: string;
  campaignName: string;
  campaignStatus: 'RUNNING' | 'PAUSED' | 'ENDED';
  marketplaceId: string;
  fundingStrategy: {
    fundingModel: string;
    bidPercentage: string;
  };
  startDate: string;
  endDate?: string;
}

export interface EbayAdResponse {
  adId: string;
  bidPercentage: string;
  inventoryReferenceId: string;
  inventoryReferenceType: string;
  adStatus: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

export interface BatchAdCreateRequest {
  requests: AdCreateRequest[];
}

export interface BatchAdCreateResponse {
  ads: Array<{
    adId?: string;
    inventoryReferenceId: string;
    statusCode: number;
    errors?: any[];
  }>;
}

// ============================================================================
// STATISTICS & REPORTING
// ============================================================================

export interface PromotionStats {
  offerId: string;
  campaignId: string;
  adId: string;
  impressions: number;
  clicks: number;
  clickThroughRate: number;
  sales: number;
  salesConversionRate: number;
  adFees: number;
  revenue: number;
  roi: number; // (revenue - adFees) / adFees
  dateRange: {
    start: Date;
    end: Date;
  };
}

export interface PriceReductionStats {
  offerId: string;
  totalReductions: number;
  totalReductionAmount: number;
  totalReductionPercentage: number;
  currentPrice: number;
  originalPrice: number;
  minPriceReached: boolean;
  nextScheduledReduction?: Date;
  schedule: 'daily' | 'weekly' | 'monthly';
}
