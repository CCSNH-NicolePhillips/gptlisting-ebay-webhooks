import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";

export const handler: Handler = async () => {
  try {
    const refresh = process.env.EBAY_TEST_REFRESH_TOKEN;
    if (!refresh) return { statusCode: 400, body: "Set EBAY_TEST_REFRESH_TOKEN first." };
    const { access_token } = await accessTokenFromRefresh(refresh);

    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const key = process.env.EBAY_MERCHANT_LOCATION_KEY || "default-loc";

    const payload = {
      name: process.env.SHIP_NAME || "Default Location",
      merchantLocationStatus: "ENABLED",
      location: {
        address: {
          addressLine1: process.env.SHIP_ADDRESS1 || "Address line 1",
          city: process.env.SHIP_CITY || "City",
          stateOrProvince: process.env.SHIP_STATE || "ST",
          postalCode: process.env.SHIP_POSTAL || "00000",
          country: process.env.SHIP_COUNTRY || "US",
        },
      },
      locationTypes: ["STORE", "WAREHOUSE"],
      merchantLocationKey: key,
    };

    const r = await fetch(`${apiHost}/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    return { statusCode: r.status, headers: { "Content-Type": "application/json" }, body: text };
  } catch (e: any) {
    return { statusCode: 500, body: `init-location error: ${e.message}` };
  }
};
