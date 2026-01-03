import type { Handler, HandlerEvent } from "@netlify/functions";

/**
 * Amazon SP-API OAuth login start page
 * This is the "OAuth Login URI" for Amazon app registration
 * 
 * OAuth Login URI: https://draftpilot.app/.netlify/functions/amazon-auth-start
 */
export const handler: Handler = async (event: HandlerEvent) => {
  const clientId = process.env.AMAZON_SP_CLIENT_ID || "";
  const redirectUri = "https://draftpilot.app/.netlify/functions/amazon-auth-callback";
  
  // Generate a random state for CSRF protection
  const state = Math.random().toString(36).substring(2, 15);
  
  // Amazon SP-API authorization URL
  // Note: For self-authorization, we use the sellercentral authorization endpoint
  const amazonAuthUrl = clientId 
    ? `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${clientId}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`
    : null;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DraftPilot - Connect with Amazon</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
    }
    .logo {
      font-size: 32px;
      font-weight: 700;
      color: #1a1a2e;
      margin-bottom: 8px;
    }
    .logo span { color: #ff9900; }
    .subtitle {
      color: #666;
      margin-bottom: 32px;
    }
    h1 { 
      font-size: 22px; 
      margin-bottom: 16px;
      color: #333;
    }
    p { 
      color: #666; 
      line-height: 1.6; 
      margin-bottom: 24px;
    }
    .amazon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: #ff9900;
      color: #111;
      border: none;
      padding: 16px 32px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s;
    }
    .amazon-btn:hover { background: #e68a00; }
    .amazon-btn svg { width: 24px; height: 24px; }
    .features {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #eee;
      text-align: left;
    }
    .features h3 {
      font-size: 14px;
      color: #333;
      margin-bottom: 12px;
    }
    .features ul {
      list-style: none;
      color: #666;
      font-size: 14px;
    }
    .features li {
      padding: 6px 0;
      padding-left: 24px;
      position: relative;
    }
    .features li::before {
      content: "✓";
      position: absolute;
      left: 0;
      color: #22c55e;
      font-weight: bold;
    }
    .error-msg {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Draft<span>Pilot</span></div>
    <div class="subtitle">eBay Listing Automation</div>
    
    <h1>Connect with Amazon</h1>
    <p>Link your Amazon Seller account to enable automatic product pricing and ASIN lookups.</p>
    
    ${!clientId ? `
      <div class="error-msg">
        Amazon SP-API credentials not configured. Please set AMAZON_SP_CLIENT_ID in your environment.
      </div>
    ` : `
      <a href="${amazonAuthUrl}" class="amazon-btn">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M13.958 10.09c0 1.232.029 2.256-.591 3.351-.502.891-1.301 1.438-2.186 1.438-1.214 0-1.922-.924-1.922-2.292 0-2.692 2.415-3.182 4.7-3.182v.685zm3.186 7.705c-.209.189-.512.201-.748.074-1.051-.872-1.238-1.276-1.814-2.106-1.736 1.77-2.965 2.3-5.209 2.3-2.66 0-4.731-1.641-4.731-4.925 0-2.565 1.391-4.309 3.37-5.164 1.715-.754 4.11-.891 5.942-1.095v-.41c0-.753.058-1.642-.383-2.294-.385-.579-1.124-.82-1.775-.82-1.205 0-2.277.618-2.54 1.897-.054.285-.261.567-.549.582l-3.061-.333c-.259-.056-.548-.266-.472-.66C6.035 1.866 8.896.5 11.471.5c1.325 0 3.055.354 4.1 1.357 1.325 1.236 1.197 2.886 1.197 4.683v4.238c0 1.273.529 1.831 1.027 2.521.173.247.211.543-.004.725-.541.453-1.505 1.298-2.037 1.77l-.61-.099z"/>
        </svg>
        Connect with Amazon
      </a>
    `}
    
    <div class="features">
      <h3>What you're authorizing:</h3>
      <ul>
        <li>Read product catalog information</li>
        <li>Access pricing data for accurate listings</li>
        <li>Look up ASINs by UPC/EAN</li>
      </ul>
    </div>
  </div>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
};
