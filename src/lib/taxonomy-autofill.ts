import type { CategoryDef, ItemSpecific } from "./taxonomy-schema.js";

type GroupRecord = Record<string, any>;

function extractGroupValue(group: GroupRecord, specific: ItemSpecific): string | undefined {
  if (specific.source === "group" && specific.from) {
    const raw = group?.[specific.from];
    if (raw == null) return undefined;
    if (Array.isArray(raw)) {
      const [first] = raw;
      if (first == null) return undefined;
      return String(first);
    }
    return String(raw);
  }

  if (specific.source === "static" && typeof specific.static === "string") {
    return specific.static;
  }

  return undefined;
}

export function buildItemSpecifics(cat: CategoryDef, group: GroupRecord): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  const requiredAspects = new Set<string>();

  // First, populate from category-specific requirements
  for (const specific of cat.itemSpecifics || []) {
    if (specific.required) {
      requiredAspects.add(specific.name);
    }
    const value = extractGroupValue(group, specific);
    if (value && value.trim()) {
      aspects[specific.name] = [value.trim()];
    } else if (specific.required) {
      aspects[specific.name] = [];
    }
  }

  // Merge in aspects provided directly in the group (e.g., from ChatGPT)
  if (group.aspects && typeof group.aspects === 'object') {
    for (const [name, value] of Object.entries(group.aspects)) {
      if (Array.isArray(value) && value.length > 0) {
        aspects[name] = value;
      } else if (typeof value === 'string' && value.trim()) {
        aspects[name] = [value.trim()];
      }
    }
  }

  // Ensure Brand is ALWAYS present (required by eBay for almost all categories)
  if (!aspects.Brand || aspects.Brand.length === 0 || !aspects.Brand[0]?.trim()) {
    // Try multiple sources for brand
    let brandValue: string | undefined;
    
    // 1. Check group.brand
    if (group.brand && typeof group.brand === 'string' && group.brand.trim()) {
      brandValue = group.brand.trim();
      console.log(`✓ Brand set from group.brand: "${brandValue}"`);
    }
    // 2. Check if brand is in a different field (common ChatGPT variations)
    else if (group.manufacturer && typeof group.manufacturer === 'string' && group.manufacturer.trim()) {
      brandValue = group.manufacturer.trim();
      console.log(`✓ Brand set from group.manufacturer: "${brandValue}"`);
    }
    // 3. Extract from product name if it contains recognizable brand patterns
    else if (group.product && typeof group.product === 'string') {
      const productLower = group.product.toLowerCase();
      // Common brand patterns (you can expand this list)
      const commonBrands = ['nike', 'adidas', 'apple', 'samsung', 'sony', 'microsoft', 'dell', 'hp', 'lenovo', 'asus'];
      for (const brand of commonBrands) {
        if (productLower.includes(brand)) {
          brandValue = brand.charAt(0).toUpperCase() + brand.slice(1);
          console.log(`✓ Brand extracted from product name: "${brandValue}"`);
          break;
        }
      }
    }
    
    // Fallback to "Unbranded" if still no brand found
    if (!brandValue) {
      brandValue = 'Unbranded';
      console.warn(`⚠️ No brand found in group, using fallback: "Unbranded"`, { 
        groupKeys: Object.keys(group),
        hasBrand: !!group.brand,
        brandValue: group.brand 
      });
    }
    
    aspects.Brand = [brandValue];
  } else {
    console.log(`✓ Brand already set: "${aspects.Brand[0]}"`);
  }

  // Fill in common required aspects that might be missing with sensible defaults
  // This handles cases where ChatGPT picks a category but doesn't provide all required aspects
  const commonDefaults: Record<string, string> = {
    'Type': 'Other',
    'Model': 'Does Not Apply',
    'MPN': 'Does Not Apply',
    'Country/Region of Manufacture': 'Unknown',
  };

  for (const [aspectName, defaultValue] of Object.entries(commonDefaults)) {
    if (requiredAspects.has(aspectName) && (!aspects[aspectName] || aspects[aspectName].length === 0)) {
      aspects[aspectName] = [defaultValue];
    }
  }

  return aspects;
}
