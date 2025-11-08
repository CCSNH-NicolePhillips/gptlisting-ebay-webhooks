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

  // Ensure Brand is always present (required by eBay for most categories)
  if (!aspects.Brand || aspects.Brand.length === 0) {
    if (group.brand && typeof group.brand === 'string' && group.brand.trim()) {
      aspects.Brand = [group.brand.trim()];
    } else {
      // Fallback to "Unbranded" if no brand is specified
      aspects.Brand = ['Unbranded'];
    }
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
