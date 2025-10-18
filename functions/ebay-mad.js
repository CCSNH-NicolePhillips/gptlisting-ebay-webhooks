// /.netlify/functions/ebay-mad
// Netlify Function (CommonJS) for eBay Marketplace Account Deletion (MAD) s
const crypto = require("crypto");

exports.handler = async function (event, context) {
  const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;
  const ENDPOINT = process.env.EBAY_ENDPOINT_URL;

  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const challengeCode = params.challenge_code;
    if (!challengeCode || !VERIFICATION_TOKEN || !ENDPOINT) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "missing challenge inputs" })
      };
    }
    const hash = crypto.createHash("sha256");
    hash.update(String(challengeCode));
    hash.update(String(VERIFICATION_TOKEN));
    hash.update(String(ENDPOINT));
    const challengeResponse = hash.digest("hex");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ challengeResponse })
    };
  }

  if (event.httpMethod === "POST") {
    // Ack quickly so eBay stops retrying.
    // Optionally: verify event.headers['x-ebay-signature'] before processing.
    console.log("MAD notification:", {
      headers: event.headers,
      body: event.body
    });
    return { statusCode: 200, body: "" };
  }

  return {
    statusCode: 405,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: "method not allowed" })
  };
};
