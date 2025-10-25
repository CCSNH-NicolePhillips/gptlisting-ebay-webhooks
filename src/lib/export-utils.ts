export function groupsToCSV(groups: unknown): string {
  if (!Array.isArray(groups) || groups.length === 0) {
    return "";
  }

  const headers = [
    "groupId",
    "brand",
    "product",
    "variant",
    "size",
    "category",
    "confidence",
    "images"
  ];

  const lines: string[] = [headers.join(",")];

  for (const entry of groups) {
    const row = headers.map((field) => {
      const value = Array.isArray((entry as any)?.[field])
        ? ((entry as any)[field] as unknown[]).join(" ")
        : (entry as any)?.[field] ?? "";
      const stringified = String(value);
      return `"${stringified.replace(/"/g, '""')}"`;
    });

    lines.push(row.join(","));
  }

  return lines.join("\n");
}
