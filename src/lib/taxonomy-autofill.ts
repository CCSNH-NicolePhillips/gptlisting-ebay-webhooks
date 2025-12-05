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
  console.log('[buildItemSpecifics] Input group:', JSON.stringify({
    brand: group.brand,
    product: group.product,
    manufacturer: group.manufacturer,
    category: group.category,
    aspectsKeys: group.aspects ? Object.keys(group.aspects) : [],
    allKeys: Object.keys(group),
  }, null, 2));
  
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
  console.log('[buildItemSpecifics] Checking group.aspects:', {
    hasAspects: !!group.aspects,
    aspectsType: typeof group.aspects,
    aspectsKeys: group.aspects ? Object.keys(group.aspects) : [],
    aspectsValue: group.aspects
  });
  
  // Placeholder values to filter out (GPT sometimes returns these)
  const placeholders = [
    'select', 'choose', '...', 'value', 'not applicable', 'n/a', 
    'does not apply', 'see description'
  ];
  
  const isPlaceholder = (val: string): boolean => {
    const lower = val.toLowerCase().trim();
    if (lower.length === 0) return true;
    if (lower.length > 50) return false; // Long values are likely real
    return placeholders.some(p => lower.includes(p) && lower.length < 30);
  };
  
  if (group.aspects && typeof group.aspects === 'object') {
    console.log('[buildItemSpecifics] Merging group.aspects into aspects...');
    for (const [name, value] of Object.entries(group.aspects)) {
      if (Array.isArray(value) && value.length > 0) {
        const filtered = value.filter(v => {
          const str = String(v || '').trim();
          return str && !isPlaceholder(str);
        });
        if (filtered.length > 0) {
          aspects[name] = filtered;
          console.log(`  ✓ Merged ${name}: ${JSON.stringify(filtered)}`);
        } else {
          console.log(`  ✗ Skipped ${name}: all values were placeholders`);
        }
      } else if (typeof value === 'string' && value.trim()) {
        if (!isPlaceholder(value.trim())) {
          aspects[name] = [value.trim()];
          console.log(`  ✓ Merged ${name}: ["${value.trim()}"]`);
        } else {
          console.log(`  ✗ Skipped ${name}: placeholder value "${value.trim()}"`);
        }
      } else {
        console.log(`  ✗ Skipped ${name}: invalid value type/empty`);
      }
    }
  } else {
    console.log('[buildItemSpecifics] No valid group.aspects to merge');
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

  // Fill in common required aspects with sensible defaults
  // Always ensure these are present, regardless of whether category marks them as required
  const commonDefaults: Record<string, string> = {
    'Type': 'Other',
    'Model': 'Does Not Apply',
    'MPN': 'Does Not Apply',
    'Country/Region of Manufacture': 'Unknown',
    'UPC': 'Does Not Apply',
    'ISBN': 'Does Not Apply',
    'EAN': 'Does Not Apply',
  };

  for (const [aspectName, defaultValue] of Object.entries(commonDefaults)) {
    // Fill if missing OR empty
    if (!aspects[aspectName] || aspects[aspectName].length === 0 || !aspects[aspectName][0]?.trim()) {
      aspects[aspectName] = [defaultValue];
      console.log(`✓ ${aspectName} auto-filled with: "${defaultValue}"`);
    }
  }
  
  // Auto-fill REQUIRED aspects from category definition that are still missing
  // This ensures eBay API doesn't reject due to missing required specifics
  for (const specific of cat.itemSpecifics || []) {
    if (specific.required && (!aspects[specific.name] || aspects[specific.name].length === 0 || !aspects[specific.name][0]?.trim())) {
      // Provide intelligent defaults based on aspect name
      let defaultValue = 'Does Not Apply';
      
      // Formulation is common for supplements/cosmetics
      if (specific.name === 'Formulation') {
        // PRIORITY 1: Check keyText from Vision API (most reliable - actual product label)
        const keyText = Array.isArray(group.keyText) ? group.keyText.join(' ').toLowerCase() : '';
        
        // PRIORITY 2: Fall back to product name if no keyText available
        const productLower = (group.product || '').toLowerCase();
        const searchText = keyText || productLower;
        
        // Detect formulation from actual label text or title
        if (searchText.includes('liquid') || searchText.includes('drops') || searchText.includes('oil') || searchText.includes('dropper')) {
          defaultValue = 'Liquid';
        } else if (searchText.includes('capsule') || searchText.includes('cap') || searchText.includes('softgel')) {
          defaultValue = 'Capsule';
        } else if (searchText.includes('tablet') || searchText.includes('tab')) {
          defaultValue = 'Tablet';
        } else if (searchText.includes('powder') || searchText.includes('mix')) {
          defaultValue = 'Powder';
        } else if (searchText.includes('gummies') || searchText.includes('gummy')) {
          defaultValue = 'Gummy';
        } else if (searchText.includes('cream') || searchText.includes('lotion')) {
          defaultValue = 'Cream';
        } else if (searchText.includes('gel')) {
          defaultValue = 'Gel';
        } else {
          defaultValue = 'Other';
        }
        
        console.log(`[buildItemSpecifics] Formulation inference: "${defaultValue}" (from ${keyText ? 'keyText' : 'product name'}: "${searchText.substring(0, 100)}")`);
      }
      // Main Purpose for supplements
      else if (specific.name === 'Main Purpose') {
        defaultValue = 'General Wellness';
      }
      // Features
      else if (specific.name === 'Features') {
        defaultValue = 'See Description';
      }
      // Active Ingredients
      else if (specific.name === 'Active Ingredients') {
        defaultValue = 'See Description';
      }
      
      aspects[specific.name] = [defaultValue];
      console.log(`✓ Required aspect "${specific.name}" auto-filled with: "${defaultValue}"`);
    }
  }

  return aspects;
}
