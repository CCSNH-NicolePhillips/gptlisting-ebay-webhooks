export function groupsToCSV(groups) {
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

  const lines = [headers.join(",")];

  for (const entry of groups) {
    const row = headers.map((field) => {
      const value = Array.isArray(entry?.[field]) ? entry[field].join(" ") : entry?.[field] ?? "";
      const stringified = String(value);
      return `"${stringified.replace(/"/g, '""')}"`;
    });

    lines.push(row.join(","));
  }

  return lines.join("\n");
}
