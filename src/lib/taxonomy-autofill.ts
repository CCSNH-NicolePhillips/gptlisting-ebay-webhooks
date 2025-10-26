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

  for (const specific of cat.itemSpecifics || []) {
    const value = extractGroupValue(group, specific);
    if (value && value.trim()) {
      aspects[specific.name] = [value.trim()];
    } else if (specific.required) {
      aspects[specific.name] = [];
    }
  }

  return aspects;
}
