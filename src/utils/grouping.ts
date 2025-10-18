type Entry = { name: string; path_lower: string; [k: string]: any };

export function groupProductsFromDropbox(entries: Entry[]) {
  const map = new Map<string, { sku: string; main: Entry | null; gallery: Entry[]; priceImageName: string }>();
  for (const e of entries) {
    if (!e.name.includes('_')) continue;
    const [prefix, rest] = e.name.split('_', 2);
    if (!prefix || !rest) continue;

    const key = prefix;
    if (!map.has(key)) map.set(key, { sku: key, main: null, gallery: [], priceImageName: '' });
    const g = map.get(key)!;
    const lower = rest.toLowerCase();

    if (lower.startsWith('01')) g.main = e;
    else if (lower.startsWith('price')) g.priceImageName = e.name;
    else g.gallery.push(e);
  }
  return Array.from(map.values()).filter(g => g.main);
}
