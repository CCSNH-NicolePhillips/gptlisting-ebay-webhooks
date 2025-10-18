import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";

export const handler: Handler = async (event) => {
  const VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN;
  const ENDPOINT = process.env.EBAY_ENDPOINT_URL;

  // Some callers (or platforms) may send a HEAD or OPTIONS probe before POSTing.
  if (event.httpMethod === "HEAD") {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Allow": "GET,POST,HEAD,OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Allow": "GET,POST,HEAD,OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod === "GET") {
    const challengeCode = event.queryStringParameters?.challenge_code;
    if (!challengeCode || !VERIFICATION_TOKEN || !ENDPOINT) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "missing challenge inputs" }),
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Allow": "GET,POST,HEAD,OPTIONS",
        },
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
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Allow": "GET,POST,HEAD,OPTIONS",
      },
    };
  }

  if (event.httpMethod === "POST") {
    console.log("MAD notification:", { headers: event.headers, body: event.body });
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Allow": "GET,POST,HEAD,OPTIONS",
      },
      body: JSON.stringify({ ok: true }),
    };
  }

  return {
    statusCode: 405,
    body: JSON.stringify({ error: "method not allowed" }),
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Allow": "GET,POST,HEAD,OPTIONS",
    },
  };
};
