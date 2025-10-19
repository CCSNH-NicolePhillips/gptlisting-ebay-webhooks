import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";

function tryJson(t: string) { try { return JSON.parse(t); } catch { return t; } }

export const handler: Handler = async () => {
  try {
    const refresh = process.env.EBAY_TEST_REFRESH_TOKEN as string | undefined;
    if (!refresh) return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Set EBAY_TEST_REFRESH_TOKEN first." }) };

    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const key = process.env.EBAY_MERCHANT_LOCATION_KEY || "default-loc";

    const payload = {
      name: process.env.SHIP_NAME || "Home",
      merchantLocationStatus: "ENABLED",
      merchantLocationKey: key,
      locationTypes: ["WAREHOUSE"],
      location: {
        address: {
          addressLine1: process.env.SHIP_ADDRESS1 || "Address line 1",
          city: process.env.SHIP_CITY || "City",
          stateOrProvince: process.env.SHIP_STATE || "ST",
          postalCode: process.env.SHIP_POSTAL || "00000",
          country: process.env.SHIP_COUNTRY || "US",
        },
        phone: process.env.SHIP_PHONE || "6038511950",
        operatingHours: [
          { dayOfWeekEnum: "MONDAY",    interval: [{ open: "09:00:00", close: "17:00:00" }] },
          { dayOfWeekEnum: "TUESDAY",   interval: [{ open: "09:00:00", close: "17:00:00" }] },
          { dayOfWeekEnum: "WEDNESDAY", interval: [{ open: "09:00:00", close: "17:00:00" }] },
          { dayOfWeekEnum: "THURSDAY",  interval: [{ open: "09:00:00", close: "17:00:00" }] },
          { dayOfWeekEnum: "FRIDAY",    interval: [{ open: "09:00:00", close: "17:00:00" }] },
        ],
      },
    };

    const url = `${apiHost}/sell/inventory/v1/location`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.status === 201 || resp.status === 409) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, key, status: resp.status, methodUsed: "POST /location" }) };
    }
    const text = await resp.text();
    return { statusCode: resp.status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "post-location failed", status: resp.status, url, payload, response: tryJson(text) }) };
  } catch (e: any) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: `init-location error: ${e.message}` }) };
  }
};
