# SmartDrafts Create Drafts Endpoint

## Overview
The `smartdrafts-create-drafts-bg` endpoint takes paired products from the pairing phase and generates complete eBay-ready listings using ChatGPT via background jobs. This replaces the old synchronous `smartdrafts-create-drafts` endpoint to avoid Netlify's 10-second timeout limit.

## Architecture

### Background Job Pattern
- **Initiator** (`smartdrafts-create-drafts-bg`): Accepts request, creates job, invokes background worker
- **Worker** (`smartdrafts-create-drafts-background`): Processes all products in parallel with GPT-4o
- **Status** (`smartdrafts-create-drafts-status`): Polls for job completion and retrieves results

### Endpoints
```
POST /.netlify/functions/smartdrafts-create-drafts-bg      # Start background job
GET  /.netlify/functions/smartdrafts-create-drafts-status  # Poll for status
POST /.netlify/functions/smartdrafts-create-drafts         # Legacy synchronous (deprecated)
```

## What It Does

### Phase 1: Category List Generation (NEW!)
- Loads eBay taxonomy from CSV (20,000+ categories)
- Filters to 20 most relevant categories based on product keywords
- Presents filtered list to GPT for accurate selection
- Fallback to common categories if no matches found

### Phase 2: Category Selection
- GPT chooses best category by ID from the provided list
- **ACCURATE**: GPT sees actual eBay categories, not guesses
- Fallback to `pickCategoryForGroup` if GPT doesn't provide categoryId
- Uses brand, product name, variant, size hints

### Phase 3: GPT Content Generation
- Builds detailed prompt with:
  - Product information (brand, product, variant, size)
  - **Available eBay categories** (20 most relevant)
  - Category hints and suggested aspects
  - Matching evidence from pairing
- Calls OpenAI GPT-4o with web search to generate:
  - **categoryId**: Exact eBay category ID from provided list
  - **Title**: ≤80 chars, professional, no emojis
  - **Description**: 2-4 sentences, factual claims
  - **Bullets**: 3-5 key features/benefits
  - **Aspects**: Item specifics (Brand, Type, Features, Size, etc.)
  - **Price**: Current retail price from Amazon/Walmart (NOT sale prices!)
  - **Condition**: NEW or USED

### Phase 4: Response Parsing (CRITICAL FIX!)
- Strips markdown code blocks (`\`\`\`json ... \`\`\``) from GPT response
- Parses cleaned JSON
- Validates and normalizes all fields
- Looks up categoryId in taxonomy database

### Phase 5: Pricing Formula Application
- Takes retail price from GPT (Amazon/Walmart search)
- Applies category-specific caps:
  - **Books**: $35 max
  - **DVDs/Media**: $25 max
- Applies discount formula: 10% off + $5 if over $30
- Example: $34.99 book → $35 cap → $31.50 (10% off) → $31.50 (no extra $5 since under $30 after discount)

### Phase 6: Normalization & Enrichment
- Normalizes aspects to string arrays
- Ensures Brand and Size are included
- Collects all images (front, back, extras)
- Returns complete draft ready for eBay

## Request Format

### Background Job Request
```json
{
  "products": [
    {
      "productId": "wishtrend_acid_duo",
      "brand": "By Wishtrend",
      "product": "Acid-Duo 2% Mild Gel Cleanser",
      "variant": "Hibiscus AHA-BHA",
      "size": "150ml",
      "categoryPath": "Health & Beauty > Skin Care",
      "heroDisplayUrl": "https://...",
      "backDisplayUrl": "https://...",
      "extras": ["https://..."],
      "evidence": ["Brand match", "Visual similarity: 1.000"]
    }
  ]
}
```

### Background Job Response (Immediate)
```json
{
  "ok": true,
  "jobId": "3df6db39-c81c-45c3-8d11-21c6f82f9a8d"
}
```

### Status Poll Request
```
GET /.netlify/functions/smartdrafts-create-drafts-status?jobId=3df6db39-c81c-45c3-8d11-21c6f82f9a8d
```

### Status Poll Response (In Progress)
```json
{
  "ok": true,
  "job": {
    "jobId": "3df6db39-c81c-45c3-8d11-21c6f82f9a8d",
    "state": "running",
    "totalProducts": 4,
    "processedProducts": 2,
    "startedAt": 1699747200000
  }
}
```

### Status Poll Response (Completed)
```json
{
  "ok": true,
  "job": {
    "jobId": "3df6db39-c81c-45c3-8d11-21c6f82f9a8d",
    "state": "completed",
    "totalProducts": 4,
    "processedProducts": 4,
    "startedAt": 1699747200000,
    "finishedAt": 1699747260000,
    "drafts": [
      {
        "productId": "bobbi_brown_still_bobbi",
        "brand": "Bobbi Brown",
        "product": "Still Bobbi",
        "title": "Still Bobbi by Bobbi Brown: A Biography",
        "description": "Discover the inspirational journey of Bobbi Brown...",
        "bullets": [
          "Insightful biography by beauty icon Bobbi Brown",
          "Hardcover edition with 300+ pages",
          "Published by Chronicle Books, 2023"
        ],
        "aspects": {
          "Brand": ["Bobbi Brown"],
          "Type": ["Biography"],
          "Format": ["Hardcover"],
          "Author": ["Bobbi Brown"],
          "Language": ["English"],
          "Publisher": ["Chronicle Books"],
          "Publication Year": ["2023"]
        },
        "category": {
          "id": "168113",
          "title": "Books",
          "aspects": {}
        },
        "images": [
          "https://...front.jpg",
          "https://...back.jpg"
        ],
        "price": 31.50,
        "condition": "NEW"
      }
    ],
    "errors": []
  }
}
```

## Integration with Existing Flow

### Current Workflow (WORKING END-TO-END!)
1. **Scan** (`smartdrafts-scan-bg`) → Analyzes images with Vision API
2. **Pairing** (`smartdrafts-pairing`) → Matches front/back images (100% pair rate!)
3. ✅ **Create Drafts** (`smartdrafts-create-drafts-bg`) → Generates listings with GPT-4o
4. ✅ **Publish to eBay** (`create-ebay-draft-user`) → Creates inventory items and offers
5. **Review** (`drafts.html`) → User reviews and publishes drafts

### Quick List Page Integration
The `public/quick-list.html` page orchestrates the entire flow:

**Step 1: Scan Images**
- Calls `smartdrafts-scan-bg` with Dropbox folder path
- Polls `smartdrafts-scan-status` every 1.5s (max 80 attempts = 2 min)
- Displays: "Scanning folder..."

**Step 2: Pair Products**  
- Calls `smartdrafts-pairing` with jobId from scan
- Uses auto-pairing with CLIP embeddings for 100% pair rate
- Displays: "Pairing images..."

**Step 3: Create Drafts**
- Calls `smartdrafts-create-drafts-bg` with products array
- Polls `smartdrafts-create-drafts-status` every 1.5s (max 120 attempts = 3 min)
- Displays: "Creating drafts (2/4)..."
- **CRITICAL**: GPT generates ALL content in parallel

**Step 4: Publish to eBay**
- Maps draft objects to eBay group format
- Calls `create-ebay-draft-user` with groups array
- Creates inventory items and unpublished offers
- Displays: "Publishing to eBay..."

### Data Flow
```
Dropbox Folder
    ↓
Vision Analysis (roles, product info, category hints)
    ↓
Pairing (group front/back/extras by product)
    ↓
GPT Draft Generation (title, desc, bullets, aspects, price, category)
    ↓
eBay Taxonomy Mapping (validate aspects, apply defaults)
    ↓
eBay Inventory Item Creation (SKU, aspects, images)
    ↓
eBay Offer Creation (price, quantity, policies, category)
    ↓
Drafts Page (review and publish)
```

## Testing

### Quick List Page (Recommended)
```
1. Go to https://draftpilot-ai.netlify.app/quick-list.html
2. Select Dropbox folder
3. Click "Start Pipeline"
4. Watch all 4 steps complete automatically
5. Check drafts.html for created listings
```

### Local Testing (Netlify Dev)
```bash
# Start Netlify dev server
netlify dev

# Run test script
tsx scripts/test-create-drafts-local.ts
```

### Manual API Testing
```bash
# 1. Start background job
curl -X POST http://localhost:8888/.netlify/functions/smartdrafts-create-drafts-bg \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"products": [...]}'

# Response: {"ok":true,"jobId":"abc-123"}

# 2. Poll for status
curl "http://localhost:8888/.netlify/functions/smartdrafts-create-drafts-status?jobId=abc-123" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Configuration

### Environment Variables
- `OPENAI_API_KEY`: **Required** for GPT-4o calls
- `GPT_TIMEOUT_MS`: Timeout per GPT call (default: 30000ms)
- `GPT_RETRY_ATTEMPTS`: Retry attempts (default: 2)
- `GPT_RETRY_DELAY_MS`: Delay between retries (default: 1000ms)

### Taxonomy Data
- **Source**: `taxonomy-categories-EBAY_US.csv` (20,000+ categories)
- **Loading**: Via `taxonomy-store.ts` at startup
- **Caching**: Categories cached for 30 seconds
- **Filtering**: 20 most relevant categories sent to GPT per product

### Pricing Configuration
Category-specific price caps (applied before formula):
- **Books**: $35 max
- **DVDs/Media/CDs**: $25 max
- **Default**: No cap

Formula: `(cappedPrice * 0.9) + (price > 30 ? 5 : 0)`

## Error Handling

The background worker handles errors gracefully:
- **Individual product failures**: Don't stop the batch, reported in `errors` array
- **Partial success**: Still returns succeeded drafts
- **GPT timeouts**: 30s timeout with 2 retry attempts
- **JSON parsing**: Strips markdown code blocks before parsing
- **Category matching**: Falls back to generic category if GPT doesn't provide ID
- **Price validation**: Defaults to 0 if GPT doesn't find price

### Common Issues & Solutions

**Issue**: GPT response wrapped in ` ```json ... ``` `  
**Solution**: `parseGptResponse()` strips markdown blocks automatically

**Issue**: Category ID is empty string  
**Solution**: GPT didn't select from list, fallback category used (now fixed with category list in prompt)

**Issue**: Price is 0  
**Solution**: GPT couldn't find price on Amazon/Walmart, manual review needed

**Issue**: Timeout after 10 seconds  
**Solution**: Use background job pattern (already implemented)

**Issue**: "Chocolate Molds" category for everything  
**Solution**: Default category changed to "Everything Else" (ID: 99), plus GPT now selects accurate categories

## Recent Fixes (Nov 11, 2024)

1. ✅ **Background Jobs**: Moved from synchronous to async processing to avoid timeouts
2. ✅ **Category Accuracy**: GPT now chooses from actual eBay taxonomy (20 relevant categories)
3. ✅ **Markdown Parsing**: Strip `\`\`\`json` wrappers from GPT responses
4. ✅ **Price Caps**: Books $35, DVDs $25 to avoid overpricing
5. ✅ **Better Prompts**: "Search Amazon/Walmart for CURRENT regular price (NOT sale)"
6. ✅ **Default Category**: Changed from "Chocolate Molds" to "Everything Else"
7. ✅ **Parallel Processing**: All products processed simultaneously in background

## Performance

- **Category list generation**: ~15-18 seconds (loads 20,000+ categories, filters to 20)
- **Category fallback selection**: ~13-14 seconds (scoreRules matching)
- **GPT call**: ~3-5 seconds (with web search for pricing)
- **Total per product**: ~30-35 seconds
- **Parallelization**: 4 products processed simultaneously = ~35 seconds total (not 140s!)

## Future Enhancements

1. **Cache Category Lists**: Pre-compute common category lists to speed up filtering
2. **Optimize Taxonomy Loading**: Use indexed database instead of CSV parsing
3. **Smart Pricing**: Use historical eBay sold prices instead of retail
4. **Aspect Validation**: Validate aspects against category requirements before publishing
5. **Image Analysis**: Send image URLs to GPT-4o Vision for better descriptions
6. **A/B Testing**: Test different prompt strategies for better results
7. **Batch Optimization**: Process categories for all products in one call

## Related Files
- `netlify/functions/smartdrafts-create-drafts-bg.ts` - Job initiator endpoint
- `netlify/functions/smartdrafts-create-drafts-background.ts` - Background worker (main logic)
- `netlify/functions/smartdrafts-create-drafts-status.ts` - Status polling endpoint
- `netlify/functions/smartdrafts-create-drafts.ts` - Legacy synchronous endpoint (deprecated)
- `src/lib/taxonomy-select.ts` - Category selection and matching
- `src/lib/taxonomy-store.ts` - Category data loading and caching
- `public/quick-list.html` - All-in-one UI for complete SmartDrafts pipeline
- `public/drafts.html` - Draft review and publishing UI
- `taxonomy-categories-EBAY_US.csv` - eBay category taxonomy data (20,000+ categories)
