import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";

export const handler: Handler = async (event) => {
  const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;
  const ENDPOINT = process.env.EBAY_ENDPOINT_URL;

  if (event.httpMethod === "GET") {
    const challengeCode = event.queryStringParameters?.challenge_code;
    if (!challengeCode || !VERIFICATION_TOKEN || !ENDPOINT) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "missing challenge inputs" }),
      };
    }
    const hash = crypto.createHash("sha256");
    hash.update(String(challengeCode));
    hash.update(String(VERIFICATION_TOKEN));
    hash.update(String(ENDPOINT));
    const challengeResponse = hash.digest("hex");
    return {
      statusCode: 200,
      body: JSON.stringify({ challengeResponse }),
      headers: { "Content-Type": "application/json; charset=utf-8" },
    };
  }

  if (event.httpMethod === "POST") {
    console.log("MAD notification:", { headers: event.headers, body: event.body });
    return { statusCode: 200, body: "" };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "method not allowed" }) };
};
