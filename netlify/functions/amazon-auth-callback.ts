import type { Handler, HandlerEvent } from "@netlify/functions";

/**
 * Amazon SP-API OAuth callback handler
 * Captures the authorization code from Amazon's redirect
 * 
 * OAuth Redirect URI: https://draftpilot.app/.netlify/functions/amazon-auth-callback
 */
export const handler: Handler = async (event: HandlerEvent) => {
  const params = event.queryStringParameters || {};
  
  // Amazon sends these params on success:
  // - spapi_oauth_code: The authorization code to exchange for tokens
  // - state: The state parameter we sent (for CSRF protection)
  // - selling_partner_id: The seller's ID
  
  // On error:
  // - error: Error code
  // - error_description: Human-readable error
  
  const authCode = params.spapi_oauth_code;
  const state = params.state;
  const sellerId = params.selling_partner_id;
  const error = params.error;
  const errorDesc = params.error_description;
  
  // Build the HTML response
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DraftPilot - Amazon Authorization</title>
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
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #1a1a2e;
      margin-bottom: 24px;
    }
    .logo span { color: #ff9900; }
    .success { color: #22c55e; }
    .error { color: #ef4444; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { color: #666; line-height: 1.6; margin-bottom: 16px; }
    .code-box {
      background: #f5f5f5;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 16px;
      margin: 20px 0;
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
      user-select: all;
    }
    .label { font-weight: 600; color: #333; display: block; margin-bottom: 4px; }
    .copy-btn {
      background: #ff9900;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 16px;
    }
    .copy-btn:hover { background: #e68a00; }
    .note { font-size: 13px; color: #888; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Draft<span>Pilot</span></div>
    ${error ? `
      <h1 class="error">❌ Authorization Failed</h1>
      <p>Amazon returned an error during authorization:</p>
      <div class="code-box">
        <span class="label">Error:</span> ${error}<br>
        <span class="label">Details:</span> ${errorDesc || 'No details provided'}
      </div>
      <p>Please try the authorization process again, or contact support if the issue persists.</p>
    ` : authCode ? `
      <h1 class="success">✓ Authorization Successful</h1>
      <p>Amazon has authorized DraftPilot to access product catalog data. Copy the authorization code below:</p>
      <div class="code-box" id="auth-code">
        <span class="label">Authorization Code:</span>
        ${authCode}
      </div>
      ${sellerId ? `<p><strong>Seller ID:</strong> ${sellerId}</p>` : ''}
      <button class="copy-btn" onclick="navigator.clipboard.writeText('${authCode}').then(() => this.textContent = '✓ Copied!')">
        Copy Authorization Code
      </button>
      <p class="note">
        This code expires in 5 minutes. Exchange it for a refresh token using the SP-API token endpoint.
      </p>
    ` : `
      <h1>Amazon SP-API Authorization</h1>
      <p>This page handles OAuth callbacks from Amazon Seller Central.</p>
      <p>If you're seeing this page directly, please start the authorization process from your DraftPilot dashboard.</p>
    `}
  </div>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: html,
  };
};
