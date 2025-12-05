# eBay Condition Mapping Fix

## Issue Report
**Date:** December 5, 2025  
**Product:** Root Zero-In 60 Capsules  
**Category:** 180960 (Dietary Supplements)  
**Error:** `errorId 25021 - Item condition is required for this category`

### Problem Statement
When publishing dietary supplements to eBay, the system was throwing:
```
The eBay listing associated with the inventory item, or the unpublished offer 
has invalid item condition information. Item condition is required for this 
category. Please provide a supported condition value.
```

Despite the user selecting **"New"** condition in the UI, the draft was being published with **USED (3000)** instead of **NEW (1000)**.

### Root Cause

In `src/lib/taxonomy-map.ts`, when a category doesn't have `allowedConditions` data (which is common for categories not yet fetched/cached), the system was defaulting to:

```typescript
} else {
  // No condition data available - use safest default
  // USED (3000) is accepted by most categories, NEW (1000) is often restricted
  console.warn(`Category ${categoryId} has no allowedConditions data. Using USED (3000) as safe default.`);
  offerCondition = 3000; // ❌ WRONG FOR NEW PRODUCTS
}
```

This logic assumed USED was "safer" than NEW, which is incorrect for:
- Dietary supplements
- New products
- Factory-sealed items
- Most health & beauty items

### Solution Implemented

**File:** `src/lib/taxonomy-map.ts` (lines 199-223)

**Changes:**

1. **Removed arbitrary USED default**
   - When `allowedConditions` is missing, use the condition from GPT/user selection
   - This respects the `group.condition` or GPT-determined condition

2. **Fixed fallback priority**
   - Changed from: USED (3000) > NEW (1000) > first allowed
   - Changed to: **NEW (1000)** > USED (3000) > first allowed
   - Prioritizes NEW for supplements and new products

3. **Better logging**
   - Added `[taxonomy-map]` prefix to logs
   - Shows both numeric code and string condition for debugging

### Code Comparison

**Before:**
```typescript
} else {
  console.warn(`Category ${categoryId} has no allowedConditions data. Using USED (3000) as safe default.`);
  offerCondition = 3000; // ❌ Ignores user/GPT selection
}
```

**After:**
```typescript
} else {
  // No condition data available - use the condition we already determined from group/GPT
  // Don't override user/GPT selection with arbitrary defaults
  console.warn(`[taxonomy-map] Category ${categoryId} has no allowedConditions data. Using determined condition: ${offerCondition} (${condition})`);
  // ✅ Keeps the condition from group/GPT (e.g., NEW for supplements)
}
```

### Condition Code Reference

| Code | String Value | Use Case |
|------|--------------|----------|
| 1000 | NEW | New, factory-sealed products |
| 1500 | NEW_OTHER | New with tags/packaging issues |
| 1750 | NEW_WITH_DEFECTS | New but has minor defects |
| 2000 | CERTIFIED_REFURBISHED | Manufacturer refurbished |
| 2500 | SELLER_REFURBISHED | Seller refurbished |
| 2750 | LIKE_NEW | Used but like new |
| 3000 | USED | Standard used condition |
| 4000 | VERY_GOOD | Used - very good |
| 5000 | GOOD | Used - good |
| 6000 | ACCEPTABLE | Used - acceptable |
| 7000 | FOR_PARTS_OR_NOT_WORKING | Parts/not working |

### Test Results

**Before Fix:**
```
condition: "NEW" (from GPT)
↓
offerCondition: 3000 (USED - wrong!)
↓
eBay Error: "Item condition is required for this category"
```

**After Fix:**
```
condition: "NEW" (from GPT)
↓
conditionStringToCode("NEW") = 1000
↓
offerCondition: 1000 (NEW - correct!)
↓
✅ Publishes successfully
```

### Impact

✅ **Dietary supplements** now publish with correct NEW condition  
✅ **All new products** respect user/GPT condition selection  
✅ **No breaking changes** - existing USED products still work  
✅ **Better fallback logic** when `allowedConditions` is missing  

### Related Code

**Condition mapping function** (`src/lib/taxonomy-map.ts`):
```typescript
function conditionStringToCode(value: string): number | undefined {
  switch (value.toUpperCase()) {
    case "NEW":
      return 1000;
    case "LIKE_NEW":
    case "NEW_OTHER":
    case "NEW OTHER":
      return 1500;
    case "USED":
      return 3000;
    // ... more mappings
    default:
      return undefined;
  }
}
```

**Condition determined from** (in order of priority):
1. Category defaults: `matched?.defaults?.condition`
2. Group condition: `group?.condition`
3. Global default: `DEFAULT_CONDITION` (= "NEW")

### Deployment

**Commit:** `ea79fec`  
**Branch:** `main`  
**Status:** ✅ Deployed to production  

The fix is live and will apply to all future draft publications.

### Validation

To verify the fix worked:

1. Check draft creation logs for: `[taxonomy-map] Category 180960 has no allowedConditions data. Using determined condition: 1000 (NEW)`
2. Verify offer payload includes: `"condition": 1000`
3. eBay publish should succeed without condition errors

### Future Improvements

1. **Pre-fetch category conditions** to avoid fallback logic
   - Run background job to populate `allowedConditions` for all categories
   - Store in category cache/database

2. **Add condition validation UI** 
   - Show user which conditions are allowed for selected category
   - Warn if selected condition might not be allowed

3. **Better error messages**
   - If eBay rejects condition, show allowed conditions in error
   - Suggest correct condition based on category
