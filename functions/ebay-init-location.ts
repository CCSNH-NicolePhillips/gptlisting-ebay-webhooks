import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";
import { tokensStore } from "./_blobs.js";

export const handler: Handler = async (event) => {
  try {
    // Use connected user's refresh token
    const store = tokensStore();
    const saved = (await store.get("ebay.json", { type: "json" })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh)
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Connect eBay first" }),
      };
    const { access_token } = await accessTokenFromRefresh(refresh);

    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const qs = event?.queryStringParameters || {} as Record<string, string>;
    const key = qs["key"] || process.env.EBAY_MERCHANT_LOCATION_KEY || "default-loc";

    const payload = {
      name: qs["name"] || process.env.SHIP_NAME || "Default Location",
      merchantLocationStatus: "ENABLED",
      location: {
        address: {
          addressLine1: qs["address1"] || process.env.SHIP_ADDRESS1 || "Address line 1",
          city: qs["city"] || process.env.SHIP_CITY || "City",
          stateOrProvince: qs["state"] || process.env.SHIP_STATE || "ST",
          postalCode: qs["postal"] || process.env.SHIP_POSTAL || "00000",
          country: qs["country"] || process.env.SHIP_COUNTRY || "US",
        },
      },
      locationTypes: ["STORE", "WAREHOUSE"],
      merchantLocationKey: key,
    };

    const r = await fetch(`${apiHost}/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: `init-location error: ${e.message}` }) };
  }
};
