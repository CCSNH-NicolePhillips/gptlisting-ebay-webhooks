export function computeEbayPrice(base:number) {
  if (!isFinite(base) || base <= 0) return 0;
  let price = base * 0.9; // 10% off
  if (base > 30) price -= 5;
  // round to 2 decimals, typical $X.XX
  return Math.round(price * 100) / 100;
}

export function computeFloorPrice(ebayPrice:number) {
  // floor = 20% off the final eBay price
  const floor = ebayPrice * 0.8;
  return Math.round(floor * 100) / 100;
}
