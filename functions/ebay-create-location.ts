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
    const key = String(keyRaw).trim().replace(/\s+/g, "-");

  const name = (qs["name"] || process.env.SHIP_NAME || "").toString().trim() || "Default Location";
    const addressLine1 = (qs["address1"] || process.env.SHIP_ADDRESS1 || "").toString().trim();
    const city = (qs["city"] || process.env.SHIP_CITY || "").toString().trim();
    let stateOrProvince = (qs["state"] || process.env.SHIP_STATE || "").toString().trim();
    let postalCode = (qs["postal"] || process.env.SHIP_POSTAL || "").toString().trim();
    const country = ((qs["country"] || process.env.SHIP_COUNTRY || "US") as string).toUpperCase();
  const lat = qs["lat"] ? parseFloat(qs["lat"]) : undefined;
  const lng = qs["lng"] ? parseFloat(qs["lng"]) : undefined;
  const minimal = String(qs["minimal"] || "false").toLowerCase() === "true";
  const noPhone = String(qs["noPhone"] || "false").toLowerCase() === "true";
  const noHours = String(qs["noHours"] || "false").toLowerCase() === "true";

    if (!addressLine1 || !city || !stateOrProvince || !postalCode || !country) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "missing-address",
          message: "Provide address1, city, state, postal, and country",
          example: "/.netlify/functions/ebay-create-location?key=home&name=Home&address1=123%20Main&city=Manchester&state=NH&postal=03101&country=US",
        }),
      };
    }

    if (country === "US") {
      stateOrProvince = stateOrProvince.toUpperCase();
      const zipMatch = postalCode.match(/^(\d{5})(?:[- ]?(\d{4}))?$/);
      if (zipMatch) postalCode = zipMatch[2] ? `${zipMatch[1]}-${zipMatch[2]}` : zipMatch[1];
    }

    const payload: any = {
      name,
      merchantLocationStatus: "ENABLED",
      location: { address: { addressLine1, city, stateOrProvince, postalCode, country } },
      merchantLocationKey: key,
    };
    const omitTypes = String(qs["omitTypes"] || "false").toLowerCase() === "true";
    if (!omitTypes) payload.locationTypes = ["WAREHOUSE"];
    if (lat !== undefined && lng !== undefined) {
      payload.location.geoCoordinates = { latitude: lat, longitude: lng };
    }
    if (!minimal && !noPhone) {
      payload.location.phone = process.env.SHIP_PHONE || "6038511950";
    }
    if (!minimal && !noHours) {
      payload.location.operatingHours = [
        { dayOfWeekEnum: "MONDAY",    interval: [{ open: "09:00:00", close: "17:00:00" }] },
        { dayOfWeekEnum: "TUESDAY",   interval: [{ open: "09:00:00", close: "17:00:00" }] },
        { dayOfWeekEnum: "WEDNESDAY", interval: [{ open: "09:00:00", close: "17:00:00" }] },
        { dayOfWeekEnum: "THURSDAY",  interval: [{ open: "09:00:00", close: "17:00:00" }] },
        { dayOfWeekEnum: "FRIDAY",    interval: [{ open: "09:00:00", close: "17:00:00" }] },
      ];
    }

    const url = `${apiHost}/sell/inventory/v1/location/${encodeURIComponent(key)}`;
    const resp = await fetch(url, {
      method: "POST",
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

    const text = await resp.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (resp.status === 201 || resp.status === 409) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, key }) };
    }

    return {
      statusCode: resp.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "post-location failed", status: resp.status, url, marketplaceId: MARKETPLACE_ID, payload, response: json }),
    };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "create-location error", detail: e?.message || String(e) }) };
  }
};
