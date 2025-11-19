# Authentication 401 Error - Debug Report

**Date:** November 18, 2025  
**Issue:** Persistent 401 Unauthorized errors when calling authenticated Netlify serverless functions  
**Status:** Multiple fixes attempted, issue persists

---

## System Architecture

### Frontend
- **Framework:** Preact (React-like library)
- **Authentication:** Auth0 via custom `auth-client.js` wrapper
- **Deployment:** Netlify static site at `https://draftpilot.app`
- **Entry Point:** `public/new-smartdrafts/index.html` → `App.js`

### Backend
- **Platform:** Netlify Serverless Functions (AWS Lambda)
- **Auth Validation:** JWT token verification via `requireUserAuth()`
- **Target Endpoint:** `/.netlify/functions/smartdrafts-scan-bg`

### Authentication Flow
```
1. Page loads → auth-client.js initializes
2. App.js useEffect → ensureAuth() checks user logged in
3. App.js useEffect → getToken() retrieves JWT token
4. App sets authReady=true → enables "Analyze" button
5. User clicks "Analyze" → API call via authFetch()
6. authFetch() adds Authorization header → POST request
7. Backend receives request → validates JWT token
8. ❌ Returns 401 Unauthorized
```

---

## Code Snippets

### 1. Frontend Auth Check (App.js - Working ✅)
```javascript
// Lines 40-62 in public/new-smartdrafts/App.js
useEffect(() => {
  async function checkAuth() {
    try {
      if (!window.authClient) {
        console.warn('[App] Auth client not loaded, waiting...');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (window.authClient?.ensureAuth) {
        console.log('[App] Checking authentication...');
        const authed = await window.authClient.ensureAuth();
        if (!authed) {
          console.warn('[App] Not authenticated, redirecting to login');
          window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
          return;
        }
        
        // CRITICAL: Verify we can actually get a token before marking ready
        console.log('[App] Authentication verified, checking token availability...');
        const token = await window.authClient.getToken();
        if (!token) {
          console.error('[App] Authentication succeeded but no token available');
          setLoadingStatus('❌ Authentication error: No token available. Please refresh and login again.');
          return;
        }
        
        console.log('[App] Token available, auth ready');
        setAuthReady(true);
      }
    } catch (err) {
      console.error('[App] Auth check failed:', err);
    }
  }
  checkAuth();
}, []);
```

**Console Output:** ✅ "Token available, auth ready" logged successfully

---

### 2. Auth Client authFetch (auth-client.js - Fixed ✅)
```javascript
// Lines 420-431 in public/auth-client.js
async function authFetch(input, init = {}) {
  try { await ensureAuth(); } catch {}
  const headers = Object.assign({}, init.headers);
  
  // CRITICAL: Must have a valid token for authenticated requests
  const token = await getToken();
  if (!token) {
    throw new Error('Authentication token not available. Please login and try again.');
  }
  
  headers.Authorization = headers.Authorization || `Bearer ${token}`;
  return fetch(input, Object.assign({}, init, { headers }));
}
```

**Fix Applied:** Now throws error if no token (was silently continuing)  
**Result:** No error thrown, so token must be available when called

---

### 3. API Helper Functions (api.js - Fixed ✅)
```javascript
// Lines 4-18 in public/new-smartdrafts/lib/api.js
async function authGet(url, opts={}) {
  if (!window.authClient?.authFetch) {
    throw new Error('Authentication not ready. Please wait and try again.');
  }
  return window.authClient.authFetch(url, { method: 'GET', ...opts });
}

async function authPost(url, body, opts={}) {
  if (!window.authClient?.authFetch) {
    throw new Error('Authentication not ready. Please wait and try again.');
  }
  return window.authClient.authFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers||{}) },
    body: body ? JSON.stringify(body) : undefined,
    ...opts
  });
}
```

**Fix Applied:** Removed fallback to unauthenticated `fetch`  
**Result:** No error thrown, so authClient.authFetch is available

---

### 4. Actual API Call (api.js)
```javascript
// Lines 32-43 in public/new-smartdrafts/lib/api.js
export async function enqueueAnalyzeLive(folderUrl, { force=false } = {}) {
  if (!folderUrl) throw new Error('folderUrl required');
  
  const r = await authPost(`/.netlify/functions/smartdrafts-scan-bg`, { 
    path: folderUrl, 
    force 
  });
  if (!r.ok) throw new Error(`Enqueue failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  
  if (!data.jobId) throw new Error('No jobId returned from scan-bg');
  return data.jobId;
}
```

**Expected:** Authorization header should be present  
**Actual:** Backend returns 401 Unauthorized

---

### 5. Backend Auth Validation (smartdrafts-scan-bg.ts)
```typescript
// Lines 20-46 in netlify/functions/smartdrafts-scan-bg.ts
export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    console.error("[smartdrafts-scan-bg] Origin not allowed:", originHdr, "Allowed:", parseAllowedOrigins());
    return json(403, { ok: false, error: "Forbidden", origin: originHdr, allowed: parseAllowedOrigins() }, originHdr, METHODS);
  }

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return json(401, { ok: false, error: "Unauthorized" }, originHdr, METHODS);
  }
  
  // ... rest of handler
}
```

**Check:** `headers.authorization || headers.Authorization`  
**Issue:** One of these should contain `Bearer <token>`, but validation fails

---

## Error Evidence

### Browser Console Error
```
auth-client.js:451 
  POST https://draftpilot.app/.netlify/functions/smartdrafts-scan-bg 401 (Unauthorized)

App.js:215 
  Error: Enqueue failed 401: {"ok":false,"error":"Unauthorized"}
    at enqueueAnalyzeLive (api.js:41:20)
    at async doAnalyze (App.js:138:23)
```

### Call Stack
```
1. User clicks "Analyze" button
2. doAnalyze() called (App.js:138)
3. enqueueAnalyzeLive() called (api.js:37)
4. authPost() called (api.js:11)
5. window.authClient.authFetch() called (auth-client.js:420)
6. fetch() with Authorization header (auth-client.js:431)
7. ❌ Backend returns 401
```

---

## Fixes Attempted

### Fix #1: Add authReady State
- **Commit:** ee08116
- **Change:** Verify token exists before enabling UI
- **Result:** ✅ Token verification passes, ❌ Still get 401

### Fix #2: Remove Silent Failures
- **Commit:** cf32518
- **Changes:**
  - `authFetch()` now throws if no token (was catching errors)
  - API helpers throw if authClient not ready (was falling back to fetch)
- **Result:** ✅ No errors thrown (token available), ❌ Still get 401

---

## Observations

1. **Token Exists:** `getToken()` returns valid JWT during initialization ✅
2. **authReady Set:** UI button enables only after token verified ✅
3. **authFetch Called:** No errors thrown from authFetch() ✅
4. **Request Sent:** Network shows POST to correct endpoint ✅
5. **Response:** Backend returns 401 Unauthorized ❌

## Key Questions

### Q1: Is the Authorization header actually being sent?
**Need to verify:** Browser Network tab shows request headers with `Authorization: Bearer <token>`

### Q2: Could headers be stripped by middleware?
**Possibilities:**
- CORS preflight stripping headers?
- Netlify proxy removing Authorization?
- Case sensitivity issue (authorization vs Authorization)?

### Q3: Is the token valid at request time?
**Timing issue:**
- Token valid during `getToken()` check (initialization)
- Token expires/invalidates before actual API call?
- Auth0 session expires between check and use?

### Q4: Is there a race condition in authFetch?
**Code flow:**
```javascript
async function authFetch(input, init = {}) {
  try { await ensureAuth(); } catch {}  // <-- Catches errors, continues anyway
  const headers = Object.assign({}, init.headers);
  
  const token = await getToken();  // <-- Could this fail after ensureAuth succeeds?
  if (!token) {
    throw new Error('Authentication token not available.');
  }
  
  headers.Authorization = headers.Authorization || `Bearer ${token}`;
  return fetch(input, Object.assign({}, init, { headers }));
}
```

**Issue:** `ensureAuth()` errors are caught and ignored. Could user be logged out between ensureAuth() and getToken()?

---

## Debugging Steps Needed

### 1. Verify Authorization Header in Request
```javascript
// Add to authFetch before fetch():
console.log('[authFetch] Sending request with headers:', headers);
console.log('[authFetch] Token:', token.substring(0, 50) + '...');
```

### 2. Check Backend Received Headers
```typescript
// Add to backend handler:
console.log('[smartdrafts-scan-bg] Received headers:', JSON.stringify(headers));
console.log('[smartdrafts-scan-bg] Authorization header:', headers.authorization || headers.Authorization || 'MISSING');
```

### 3. Verify Token Format
```javascript
// Add to authFetch:
const parts = token.split('.');
console.log('[authFetch] Token parts:', parts.length); // Should be 3 for JWT
if (parts.length === 3) {
  const payload = JSON.parse(atob(parts[1]));
  console.log('[authFetch] Token exp:', new Date(payload.exp * 1000));
  console.log('[authFetch] Current time:', new Date());
  console.log('[authFetch] Expired?:', payload.exp < Date.now() / 1000);
}
```

### 4. Test with cURL
```bash
# Get token from browser console:
# > await window.authClient.getToken()

# Then test directly:
curl -X POST https://draftpilot.app/.netlify/functions/smartdrafts-scan-bg \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN_FROM_BROWSER>" \
  -d '{"path":"/test","force":false}'
```

If cURL works → Frontend not sending header correctly  
If cURL fails → Token/backend issue

---

## Hypotheses

### Hypothesis A: Header Case Sensitivity
**Theory:** Netlify/Lambda converts headers to lowercase, but code checks `headers.Authorization` (capital A)  
**Test:** Backend should check both `headers.authorization` AND `headers.Authorization`  
**Likelihood:** HIGH - Common issue in serverless environments

### Hypothesis B: Token Expiry Race Condition
**Theory:** Token expires between `getToken()` check and actual request  
**Test:** Log token exp time vs current time in authFetch  
**Likelihood:** MEDIUM - JWT tokens usually valid for hours

### Hypothesis C: CORS Preflight Issues
**Theory:** Browsers strip Authorization header from preflight OPTIONS requests  
**Test:** Backend already handles OPTIONS correctly (returns 200), so this is unlikely  
**Likelihood:** LOW - Code shows proper OPTIONS handling

### Hypothesis D: Netlify Proxy Strips Headers
**Theory:** Netlify's proxy layer removes Authorization headers for security  
**Test:** Check Netlify docs, test with raw Lambda URL  
**Likelihood:** LOW - Would break all authenticated requests

---

## Next Steps

1. **Add Logging:** Insert console.logs in authFetch to verify token and headers
2. **Check Network Tab:** Inspect actual HTTP request headers in browser DevTools
3. **Test Backend:** Add logging to see what headers backend receives
4. **Try cURL:** Test with manual request to isolate frontend vs backend
5. **Check Token Format:** Verify JWT is valid and not expired

---

## Environment Details

- **Platform:** Netlify (Frontend + Serverless Functions)
- **Auth Provider:** Auth0
- **Browser:** Chrome/Edge (Chromium-based)
- **Frontend Framework:** Preact 10.20.2
- **Node Version:** (Netlify default, likely Node 18+)

---

## Request for Help

**Primary Question:** Why does the Authorization header not reach the backend when all checks pass on the frontend?

**Specific Areas to Investigate:**
1. HTTP header case sensitivity in AWS Lambda/Netlify
2. Token format/expiry validation
3. Potential header stripping by proxy layers
4. Race conditions in async auth flow

**Expected Behavior:** Request should include `Authorization: Bearer <jwt-token>` header and backend should validate successfully.

**Actual Behavior:** Backend receives request without valid Authorization header (or header is present but token is invalid/expired/malformed).
