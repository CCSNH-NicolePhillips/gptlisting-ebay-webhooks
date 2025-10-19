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
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
    const qs = (event?.queryStringParameters || {}) as Record<string, string>;
    const keyRaw = qs["key"] || process.env.EBAY_MERCHANT_LOCATION_KEY || "default-loc";
    // Normalize merchantLocationKey: eBay docs recommend no spaces; keep to [A-Za-z0-9-_]
    const key = String(keyRaw).trim().replace(/\s+/g, "-");

    const name = (qs["name"] || process.env.SHIP_NAME || "").toString().trim();
    const addressLine1 = (qs["address1"] || process.env.SHIP_ADDRESS1 || "").toString().trim();
    const city = (qs["city"] || process.env.SHIP_CITY || "").toString().trim();
    let stateOrProvince = (qs["state"] || process.env.SHIP_STATE || "").toString().trim();
    let postalCode = (qs["postal"] || process.env.SHIP_POSTAL || "").toString().trim();
    const country = ((qs["country"] || process.env.SHIP_COUNTRY || "US") as string).toUpperCase();

    // Basic normalization for US addresses
    if (country === "US") {
      stateOrProvince = stateOrProvince.toUpperCase();
      // Convert ZIP+4 with spaces to canonical 12345-1234 form if needed
      const zipMatch = postalCode.match(/^(\d{5})(?:[- ]?(\d{4}))?$/);
      if (zipMatch) {
        postalCode = zipMatch[2] ? `${zipMatch[1]}-${zipMatch[2]}` : zipMatch[1];
      }
    }

    if (!addressLine1 || !city || !stateOrProvince || !postalCode || !country) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "missing-address",
          message: "Please provide address1, city, state, postal, and country to initialize your ship-from location.",
          example: "/.netlify/functions/ebay-init-location?key=home&name=Home&address1=123%20Main%20St&city=Manchester&state=NH&postal=03101&country=US",
        }),
      };
    }

    const payload = {
      name: name || "Default Location",
      merchantLocationStatus: "ENABLED",
      location: { address: { addressLine1, city, stateOrProvince, postalCode, country } },
      merchantLocationKey: key,
    };
    // Allow opting out of locationTypes via query (?omitTypes=true) to bypass validation edge cases
    const omitTypes = String(qs["omitTypes"] || "false").toLowerCase() === "true";
    if (!omitTypes) {
      (payload as any).locationTypes = ["WAREHOUSE"]; // eBay allowed values: WAREHOUSE, STORE
    }

    const url = `${apiHost}/sell/inventory/v1/location/${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    // Treat 200, 201, 204, 409 as success to be idempotent
    if ([200, 201, 204, 409].includes(r.status)) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, key, status: r.status, url }),
      };
    }
    if (!r.ok) {
      return {
        statusCode: r.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "init-location failed",
          step: "put-location",
          url,
          status: r.status,
          payload,
          response: json,
        }),
      };
    }
    return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: `init-location error: ${e.message}` }) };
  }
};
