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

  // First, populate from category-specific requirements
  for (const specific of cat.itemSpecifics || []) {
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

  return aspects;
}
