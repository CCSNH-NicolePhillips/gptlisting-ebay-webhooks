import { handler } from "../netlify/functions/ebay-create-draft";
import payload from "../tmp/dry-run-payload.json" assert { type: "json" };

(async () => {
  const event = {
    httpMethod: "POST",
    headers: {
      origin: "http://localhost:8888",
      host: "localhost:8888",
      "sec-fetch-site": "same-origin",
      Authorization: process.env.ADMIN_API_TOKEN ? `Bearer ${process.env.ADMIN_API_TOKEN}` : undefined,
    },
    body: JSON.stringify(payload),
  } as any;

  const response = await handler(event, {} as any);
  const { statusCode, body, headers } = response as { statusCode: number; body: string; headers: Record<string, string> };
  console.log(JSON.stringify({ statusCode, headers, body: JSON.parse(body) }, null, 2));
})();
