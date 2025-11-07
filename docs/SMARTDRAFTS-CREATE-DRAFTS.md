# SmartDrafts Create Drafts Endpoint

## Overview
The `smartdrafts-create-drafts` endpoint takes paired products from the pairing phase and generates complete eBay-ready listings using ChatGPT.

## Endpoint
```
POST /.netlify/functions/smartdrafts-create-drafts
```

## What It Does

### Phase 1: Category Selection
- For each product, picks the best eBay category using `pickCategoryForGroup`
- Uses brand, product name, variant, size, and category hints
- Returns category ID, title, and available aspects

### Phase 2: GPT Content Generation
- Builds a detailed prompt with:
  - Product information (brand, product, variant, size)
  - Category hints and suggested aspects
  - Matching evidence from pairing
- Calls OpenAI GPT-4o-mini to generate:
  - **Title**: ≤80 chars, professional, no emojis
  - **Description**: 2-4 sentences, factual claims
  - **Bullets**: 3-5 key features/benefits
  - **Aspects**: Item specifics (Brand, Type, Features, Size, etc.)
  - **Price**: Estimated retail price
  - **Condition**: NEW, LIKE_NEW, USED_EXCELLENT, etc.

### Phase 3: Normalization & Enrichment
- Normalizes aspects to string arrays
- Ensures Brand and Size are included
- Collects all images (front, back, extras)
- Returns complete draft ready for eBay

## Request Format

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
      "frontUrl": "https://...",
      "backUrl": "https://...",
      "heroDisplayUrl": "https://...",
      "backDisplayUrl": "https://...",
      "extras": [],
      "evidence": ["Brand match", "Visual similarity: 1.000"]
    }
  ]
}
```

## Response Format

```json
{
  "ok": true,
  "drafts": [
    {
      "productId": "wishtrend_acid_duo",
      "brand": "By Wishtrend",
      "product": "Acid-Duo 2% Mild Gel Cleanser",
      "title": "By Wishtrend Acid-Duo 2% Mild Gel Cleanser Hibiscus AHA-BHA 150ml",
      "description": "Gentle exfoliating cleanser with 2% AHA-BHA formula...",
      "bullets": [
        "Contains hibiscus extract for natural exfoliation",
        "2% AHA-BHA formula for smooth skin",
        "150ml size perfect for daily use"
      ],
      "aspects": {
        "Brand": ["By Wishtrend"],
        "Size": ["150ml"],
        "Type": ["Gel Cleanser"],
        "Features": ["AHA-BHA", "Exfoliating"]
      },
      "category": {
        "id": "11854",
        "title": "Health & Beauty > Skin Care > Cleansers"
      },
      "images": [
        "https://...front.jpg",
        "https://...back.jpg"
      ],
      "price": 24.99,
      "condition": "NEW"
    }
  ],
  "errors": [],
  "summary": {
    "total": 1,
    "succeeded": 1,
    "failed": 0
  }
}
```

## Integration with Existing Flow

### Current Workflow
1. **Scan** (`smartdrafts-scan-bg`) → Analyzes images with Vision API
2. **Pairing** (`smartdrafts-pairing`) → Matches front/back images
3. 🆕 **Create Drafts** (`smartdrafts-create-drafts`) → Generates listings
4. **Review & Publish** → User reviews and publishes to eBay

### Next Steps to Complete Integration

1. **Update UI to call the new endpoint**
   - After pairing completes, call `smartdrafts-create-drafts`
   - Pass the `products` array from pairing results
   - Display generated drafts to user

2. **Add draft review interface**
   - Show title, description, bullets, aspects
   - Allow editing before publishing
   - Preview images

3. **Connect to eBay publish flow**
   - Use existing `ebay-create-draft` endpoint
   - Convert draft format to eBay inventory format
   - Handle policy IDs, location, pricing

## Testing

### Local Testing (Netlify Dev)
```bash
# Start Netlify dev server
netlify dev

# Run test script
tsx scripts/test-create-drafts.ts
```

### Manual Testing
```bash
# Call the endpoint directly
curl -X POST http://localhost:8888/.netlify/functions/smartdrafts-create-drafts \
  -H "Content-Type: application/json" \
  -d '{"products": [...]}'
```

## Configuration

### Environment Variables
- `OPENAI_API_KEY`: Required for GPT calls
- `GPT_MODEL`: Model to use (default: gpt-4o-mini)
- `GPT_MAX_TOKENS`: Max response tokens (default: 1000)
- `GPT_RETRY_ATTEMPTS`: Retry attempts (default: 2)
- `GPT_RETRY_DELAY_MS`: Delay between retries (default: 1500ms)

### Taxonomy Data
- Uses existing `taxonomy-store` for category lookup
- Requires taxonomy CSV to be loaded
- Categories cached for 30 seconds

## Error Handling

The endpoint handles errors gracefully:
- Individual product failures don't stop the batch
- Failed products reported in `errors` array
- Partial success still returns succeeded drafts
- Retry logic for transient OpenAI errors

## Future Enhancements

1. **Batch Processing**: Process multiple products in parallel
2. **Smart Pricing**: Use AI to estimate prices based on product type
3. **Aspect Validation**: Validate aspects against category requirements
4. **Image Analysis**: Use front/back images to enhance GPT prompt
5. **A/B Testing**: Test different prompt strategies
6. **Caching**: Cache category picks and GPT responses

## Related Files
- `netlify/functions/smartdrafts-create-drafts.ts` - Main endpoint
- `src/lib/taxonomy-select.ts` - Category selection
- `src/lib/openai.ts` - OpenAI client
- `netlify/functions/ai-gpt-drafts.ts` - Similar endpoint for older flow
