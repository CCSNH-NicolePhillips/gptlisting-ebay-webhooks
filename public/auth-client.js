// Lightweight auth client supporting two modes:
// - Auth0 Universal Login (Google, Apple, Email) via AUTH0_DOMAIN/CLIENT_ID
// - Netlify Identity widget fallback (Email + social providers configured in Netlify)
//
// Public config is fetched from /.netlify/functions/get-public-config
// Pages can call authClient.requireAuth() to enforce login and get an access token.
(function () {
  const state = {
    mode: 'none', // 'auth0' | 'identity' | 'none'
    cfg: null,
    rawMode: 'none',
    auth0: null,
    identityReady: false,
    token: null,
    user: null,
    idTokenRaw: null,
    // Token refresh gating to prevent race conditions
    tokenRefreshPromise: null,
  };

  function clearLocalAuthState() {
    state.token = null;
    state.user = null;
    state.idTokenRaw = null;
    try {
      const ls = window.localStorage;
      if (ls) {
  const drop = [];
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i);
          if (key && key.startsWith('@@auth0')) drop.push(key);
        }
        drop.forEach((k) => ls.removeItem(k));
      }
    } catch {}
    try {
      const ss = window.sessionStorage;
      if (ss) {
  const drop = [];
        for (let i = 0; i < ss.length; i++) {
          const key = ss.key(i);
          if (key && key.startsWith('@@auth0')) drop.push(key);
        }
        drop.forEach((k) => ss.removeItem(k));
      }
    } catch {}
  }

  async function loadConfig() {
    try {
      const res = await fetch('/.netlify/functions/get-public-config');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'config');
      state.cfg = j;
      const rawMode = (j.AUTH_MODE_RAW || j.AUTH_MODE || 'none').toLowerCase();
      const hasAuth0 = Boolean(j.AUTH0_DOMAIN && j.AUTH0_CLIENT_ID);
      state.rawMode = rawMode;
      state.mode = hasAuth0 && ['admin', 'user', 'mixed', 'auth0'].includes(rawMode) ? 'auth0' : rawMode;
    } catch (e) {
      console.warn('Auth config missing; continuing unauthenticated', e);
      state.mode = 'none';
      state.cfg = {};
      state.rawMode = 'none';
    }
  }

  async function initAuth0() {
    if (!state.cfg?.AUTH0_DOMAIN || !state.cfg?.AUTH0_CLIENT_ID) return;
    if (state.auth0) return;

    try {
    // Load SPA SDK if not present. Prefer same-origin proxy to satisfy strict CSP.
    function beginAmdDisable() {
      const hadDefine = typeof window.define === 'function';
      const saved = hadDefine ? window.define : undefined;
      try { if (hadDefine) window.define = undefined; } catch {}
      return () => {
        try {
          if (hadDefine && saved) window.define = saved;
          else if (hadDefine && !saved) delete window.define;
        } catch {}
      };
    }
    async function loadSdk(url) {
      return new Promise((resolve, reject) => {
        const restore = beginAmdDisable();
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => { try { restore(); } catch {} ; resolve(); };
        s.onerror = (e) => { try { restore(); } catch {} ; reject(e); };
        document.head.appendChild(s);
      });
    }
    async function loadSdkFromBlob(url) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('fetch failed: ' + res.status);
        const js = await res.text();
        const blob = new Blob([js], { type: 'application/javascript' });
        const u = URL.createObjectURL(blob);
        try {
          await loadSdk(u);
        } finally {
          URL.revokeObjectURL(u);
        }
      } catch (e) {
        // swallow
      }
    }
      const getCreateAuth0 = () => (window.auth0 && window.auth0.createAuth0Client) || window.createAuth0Client;
    if (!window.createAuth0Client) {
      try {
        await loadSdk('/.netlify/functions/cdn-auth0-spa?v=2.5');
      } catch {
        await loadSdkFromBlob('/.netlify/functions/cdn-auth0-spa?v=2.5');
        if (!window.createAuth0Client) {
          try { await loadSdk('https://cdn.auth0.com/js/auth0-spa-js/2.5/auth0-spa-js.production.js'); }
          catch {}
        }
      }
    }
      const createAuth0 = getCreateAuth0();
      if (!createAuth0) throw new Error('Auth0 SDK not loaded');
      
      // PROACTIVE CHECK: If we have auth state in localStorage, it might be expired
      // Clear it BEFORE initializing Auth0 to prevent 403 spam
      const hasAuth0Data = Object.keys(localStorage).some(k => k.startsWith('@@auth0'));
      if (hasAuth0Data) {
        console.log('[Auth] Found existing Auth0 state, checking if expired...');
        // Try a quick validation - if we're on a protected page and have tokens,
        // they should work. If not, clear and force re-login.
        const authKeys = Object.keys(localStorage).filter(k => k.startsWith('@@auth0'));
        const hasRefreshToken = authKeys.some(k => localStorage.getItem(k)?.includes('refresh_token'));
        
        if (hasRefreshToken) {
          console.log('[Auth] Has refresh token, will let SDK try to use it...');
        } else {
          console.log('[Auth] No refresh token found, clearing stale state');
          clearLocalAuthState();
        }
      }
      
      // Track if we get 403s during init (expired refresh token)
      let got403 = false;
      let redirectPending = false; // CRITICAL: Check this before EVERY redirect
      
      const forceRelogin = () => {
        if (redirectPending) {
          // Already redirecting, throw to stop execution
          throw new Error('AUTH_REDIRECT_PENDING');
        }
        redirectPending = true;
        console.warn('[Auth] Detected expired refresh token (403), forcing re-login');

        // Clear auth immediately and aggressively
        clearLocalAuthState();

        // Also clear any Auth0 state that might be in-flight
        try {
          sessionStorage.clear();
          Object.keys(localStorage).forEach(k => {
            if (k.startsWith('@@auth0') || k.includes('auth0')) {
              localStorage.removeItem(k);
            }
          });
        } catch (e) { }

        window.fetch = origFetch;
        console.error = origConsoleError;
        sessionStorage.setItem('returnTo', window.location.pathname + window.location.search);
        
        // Redirect - use replace to prevent back button issues
        window.location.replace('/login.html');
        
        // Throw error to stop all execution
        throw new Error('AUTH_REDIRECT_PENDING');
      };
      
      // Suppress Auth0 403 token refresh errors (network + console)
      // These happen when refresh tokens expire and are harmless (user will re-login)
      const origFetch = window.fetch.bind(window);
      const origConsoleError = console.error;
      
      // Intercept fetch to detect and suppress Auth0 token 403s
      window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const isAuth0Token = url && url.includes('.auth0.com/oauth/token');

        try {
          const response = await origFetch(...args);
          // Track 403s from Auth0 token endpoint and force re-login
          if (isAuth0Token && response.status === 403) {
            got403 = true;
            // Call forceRelogin which throws
            forceRelogin();
          }
          return response;
        } catch (err) {
          // If it's our redirect error, re-throw it
          if (err.message === 'AUTH_REDIRECT_PENDING') {
            throw err;
          }

          if (isAuth0Token) {
            got403 = true;
            forceRelogin(); // This throws
          }
          throw err;
        }
      };
      
      // Also suppress console.error messages
      console.error = function(...args) {
        const msg = args.join(' ');
        if (msg.includes('auth0.com/oauth/token') && (msg.includes('403') || msg.includes('Forbidden'))) {
          return; // Silently ignore
        }
        origConsoleError.apply(console, args);
      };
      
      try {
        state.auth0 = await createAuth0({
          domain: state.cfg.AUTH0_DOMAIN,
          clientId: state.cfg.AUTH0_CLIENT_ID,
          cacheLocation: 'localstorage',
          useRefreshTokens: true,
          authorizationParams: {
            redirect_uri: window.location.origin + '/login.html',
            audience: state.cfg.AUTH0_AUDIENCE || undefined,
          },
        });

        // Handle redirect callback
        if (window.location.pathname.endsWith('/login.html')) {
          const q = window.location.search;
          if (q.includes('code=') && q.includes('state=')) {
            try {
              await state.auth0.handleRedirectCallback();
              const returnTo = sessionStorage.getItem('returnTo') || '/';
              sessionStorage.removeItem('returnTo');
              window.history.replaceState({}, document.title, '/login.html');
              window.location.assign(returnTo);
              return; // navigation
            } catch (e) {
              console.error('Auth0 callback error', e);
            }
          }
        }

        const isAuth = await state.auth0.isAuthenticated();
        
        // Check redirectPending before continuing
        if (redirectPending) return;
        
        if (isAuth) {
          state.user = await state.auth0.getUser();
          
          if (redirectPending) return;
          
          // Use gated token refresh on initial load
          // This prevents race conditions during app initialization
          try {
            state.token = await getTokenWithGating();
          } catch (e) {
            if (redirectPending) return;
            
            // If token expired/invalid, the gated function already handles it
            if (e.message === 'AUTH_EXPIRED') {
              forceRelogin(); // This throws and redirects
            }
            
            console.warn('Token acquisition failed during init:', e.message || e);
            state.token = null;
          }
          
          if (redirectPending) return;
          
          try {
            const idc = await state.auth0.getIdTokenClaims();
            state.idTokenRaw = idc && (idc.__raw || idc.raw || null);
          } catch {}
          // Make sure function calls carry Authorization as soon as we detect auth
          try { attachAuthFetch(); } catch {}
        }
        
      } catch (err) {
        // If it's our redirect error, just return - redirect is already happening
        if (err.message === 'AUTH_REDIRECT_PENDING') {
          return;
        }
        // Re-throw other errors
        throw err;
      } finally {
        // Always restore original fetch and console.error
        if (!redirectPending) {
          window.fetch = origFetch;
          console.error = origConsoleError;
        }
      }
    } catch (e) {
      // Outer catch: If we're redirecting due to 403, silently return (redirect is already in progress)
      if (e.message === 'AUTH_REDIRECT_PENDING') {
        console.log('[Auth] Redirect in progress, stopping initialization');
        return;
      }
      // Re-throw other errors
      throw e;
    }
  }

  function initIdentity() {
    return new Promise((resolve) => {
      if (window.netlifyIdentity) {
        window.netlifyIdentity.on('init', (user) => {
          state.identityReady = true;
          state.user = user;
          resolve();
        });
        window.netlifyIdentity.init();
      } else {
        const s = document.createElement('script');
        s.src = 'https://identity.netlify.com/v1/netlify-identity-widget.js';
        s.onload = () => {
          window.netlifyIdentity.on('init', (user) => {
            state.identityReady = true;
            state.user = user;
            resolve();
          });
          window.netlifyIdentity.init();
        };
        s.onerror = () => resolve();
        document.head.appendChild(s);
      }
    });
  }

  async function ensureAuth() {
    await loadConfig();
    if (state.mode === 'auth0') {
      await initAuth0();
      const isAuth = state.auth0 && (await state.auth0.isAuthenticated());
      if (!isAuth) return false;
      state.user = await state.auth0.getUser();
      // Use gated token refresh to avoid race conditions
      state.token = await getTokenWithGating().catch(() => null);
      attachAuthFetch();
      return true;
    }
    if (state.mode === 'identity') {
      await initIdentity();
      attachAuthFetch();
      return !!state.user;
    }
    return false;
  }

  async function requireAuth() {
    const ok = await ensureAuth();
    if (ok) return true;
    // Not authenticated – prefer redirecting straight to Auth0 Universal Login (no intermediary UI)
    try {
      if (state.mode === 'auth0') {
        await initAuth0();
        const returnTo = window.location.pathname + window.location.search + window.location.hash;
        sessionStorage.setItem('returnTo', returnTo);
        await state.auth0.loginWithRedirect({
          appState: { returnTo },
          authorizationParams: { redirect_uri: window.location.origin + '/login.html' },
        });
        return false; // navigation will happen
      }
    } catch (e) {
      console.error('Auth0 redirect failed, falling back to /login.html', e);
    }
    // Fallback: go to our login page which will handle config/errors
    sessionStorage.setItem('returnTo', window.location.pathname + window.location.search);
    window.location.assign('/login.html');
    return false;
  }

  async function login(opts) {
    await loadConfig();
    if (state.mode === 'auth0') {
      await initAuth0();
      const params = { appState: {} };
      if (opts?.connection) params.authorizationParams = { connection: opts.connection };
      sessionStorage.setItem('returnTo', opts?.returnTo || '/');
      await state.auth0.loginWithRedirect(params);
      return;
    }
    if (state.mode === 'identity') {
      await initIdentity();
      window.netlifyIdentity.open();
      return;
    }
    alert('Authentication is not configured. Please set AUTH_MODE and provider settings.');
  }

  async function logout(opts) {
    await loadConfig();
    if (state.mode === 'auth0' && state.auth0) {
      const rt = (opts && opts.returnTo) || window.location.origin;
      const params = { logoutParams: { returnTo: rt } };
      if (opts && typeof opts.federated === 'boolean' && opts.federated) {
        params.logoutParams.federated = true;
      }
      try {
        await state.auth0.logout(params);
      } finally {
        clearLocalAuthState();
      }
      return;
    }
    if (state.mode === 'identity' && window.netlifyIdentity) {
      window.netlifyIdentity.logout();
      if (opts && opts.returnTo) {
        window.location.assign(opts.returnTo);
      } else {
        window.location.reload();
      }
      return;
    }
  }

  // CRITICAL: Gate token refresh to prevent race conditions
  // Only one token refresh can be in-flight at a time
  async function getTokenWithGating() {
    // If a refresh is already in progress, wait for it
    if (state.tokenRefreshPromise) {
      console.log('[Auth] Token refresh already in progress, waiting...');
      try {
        return await state.tokenRefreshPromise;
      } catch (e) {
        // If the in-flight request failed, clear it and try again
        console.log('[Auth] In-flight token refresh failed, retrying...');
        state.tokenRefreshPromise = null;
      }
    }

    // Start a new refresh operation
    console.log('[Auth] Starting new token refresh...');
    state.tokenRefreshPromise = (async () => {
      try {
        if (state.mode === 'auth0' && state.auth0) {
          // Prefer ID token only if it's still valid; otherwise, acquire a fresh access token.
          const nowSec = Math.floor(Date.now() / 1000);
          const isJwtValid = (raw) => {
            try {
              const parts = String(raw || '').split('.');
              if (parts.length < 2) return false;
              const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
              const exp = Number(payload?.exp || 0);
              return Number.isFinite(exp) && exp > nowSec + 60; // 60s buffer to avoid edge cases
            } catch { return false; }
          };
          
          // First, check if we have a valid cached token
          if (state.token && isJwtValid(state.token)) {
            return state.token;
          }
          
          // Check ID token
          try {
            const idc = await state.auth0.getIdTokenClaims();
            const idRaw = (idc && (idc.__raw || idc.raw)) || null;
            if (idRaw && isJwtValid(idRaw)) {
              state.token = idRaw;
              state.idTokenRaw = idRaw;
              return idRaw;
            }
          } catch (e) {
            console.warn('[Auth] Failed to get ID token claims:', e.message);
          }
          
          if (state.idTokenRaw && isJwtValid(state.idTokenRaw)) {
            state.token = state.idTokenRaw;
            return state.idTokenRaw;
          }
          
          // Need to refresh - use cache by default (SDK will handle refresh internally)
          try {
            const at = await state.auth0.getTokenSilently();
            if (at) {
              state.token = at;
              return at;
            }
          } catch (e) {
            console.warn('[Auth] Token refresh failed:', e.message);
            
            // If refresh failed due to expired/invalid refresh token, clear state
            const isAuthError = e.message?.includes('403') || 
                               e.message?.includes('401') || 
                               e.message?.includes('login_required') ||
                               e.message?.includes('consent_required');
            
            if (isAuthError) {
              console.error('[Auth] Refresh token expired or invalid, clearing auth state');
              clearLocalAuthState();
              state.token = null;
              state.user = null;
              throw new Error('AUTH_EXPIRED');
            }
            throw e;
          }
          
          // Fallback to cached token if we have one
          if (state.token) return state.token;
          return null;
        }
        
        if (state.mode === 'identity' && window.netlifyIdentity) {
          const u = window.netlifyIdentity.currentUser();
          const jwt = await u?.jwt?.();
          state.token = jwt;
          return jwt;
        }
        
        return null;
      } finally {
        // Clear the promise after completion (success or failure)
        state.tokenRefreshPromise = null;
      }
    })();

    return state.tokenRefreshPromise;
  }

  // Backwards compatibility - keep getToken() but use gated version
  async function getToken() {
    try {
      return await getTokenWithGating();
    } catch (e) {
      if (e.message === 'AUTH_EXPIRED') {
        // Token expired, redirect to login
        console.log('[Auth] Token expired, redirecting to login...');
        sessionStorage.setItem('returnTo', window.location.pathname + window.location.search);
        window.location.replace('/login.html');
        return null;
      }
      throw e;
    }
  }

  // Explicit helper to always send Authorization for first-party function calls
  async function authFetch(input, init = {}) {
    try { await ensureAuth(); } catch {}
    const headers = Object.assign({}, init.headers);
    try {
      // Use gated token refresh to prevent race conditions
      const token = await getTokenWithGating();
      if (token) headers.Authorization = headers.Authorization || `Bearer ${token}`;
    } catch (e) {
      // If auth expired, let the error propagate so caller can handle
      if (e.message === 'AUTH_EXPIRED') {
        throw new Error('Authentication expired. Please log in again.');
      }
    }
    return fetch(input, Object.assign({}, init, { headers }));
  }

  // Patch window.fetch to automatically add Authorization to Netlify functions
  function attachAuthFetch() {
    if (window.__authFetchPatched) return;
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      try {
        const url = typeof input === 'string' ? input : input.url;
        const isFn = /\/\.netlify\/functions\//.test(url);
        if (isFn) {
          // Use gated token refresh to prevent race conditions
          const token = state.token || (await getTokenWithGating());
          if (token) {
            init.headers = Object.assign({}, init.headers, {
              Authorization: init.headers?.Authorization || `Bearer ${token}`,
            });
          }
        }
      } catch (e) {
        // If auth expired, continue without token (let backend return 401)
        if (e.message !== 'AUTH_EXPIRED') {
          console.warn('[Auth] Failed to attach token to request:', e.message);
        }
      }
      return orig(input, init);
    };
    window.__authFetchPatched = true;
  }

  async function getMode() {
    if (!state.cfg) {
      await loadConfig();
    }
    return state.mode;
  }

  window.authClient = { requireAuth, login, logout, getToken, ensureAuth, authFetch, getMode };
  // Minimal, non-invasive auth badge injected in the top-right for login/logout
  async function renderBadge() {
    try {
      await loadConfig();
      if (state.mode === 'none') return; // auth not configured – don't render
      // Light init without forcing redirects
      if (state.mode === 'auth0') {
        await initAuth0();
      } else if (state.mode === 'identity') {
        await initIdentity();
      }
      // Container
      let el = document.getElementById('auth-badge');
      if (!el) {
        el = document.createElement('div');
        el.id = 'auth-badge';
        el.style.position = 'fixed';
        el.style.top = '10px';
        el.style.right = '10px';
        el.style.zIndex = '9999';
        el.style.display = 'flex';
        el.style.gap = '8px';
        el.style.alignItems = 'center';
        el.style.padding = '6px 10px';
        el.style.borderRadius = '999px';
        el.style.background = 'rgba(20,26,51,0.85)';
        el.style.border = '1px solid #2a335c';
        el.style.color = '#e6ebff';
        el.style.font = '600 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
        document.body.appendChild(el);
      }
      // Determine auth state
      let authed = false;
      try {
        if (state.mode === 'auth0' && state.auth0) authed = await state.auth0.isAuthenticated();
        else if (state.mode === 'identity') authed = !!state.user;
      } catch {}
      const name = (state.user && (state.user.name || state.user.email)) || '';
      // Render contents
      el.innerHTML = '';
      const label = document.createElement('span');
      label.textContent = authed ? (name ? `Signed in as ${name}` : 'Signed in') : 'Not signed in';
      label.style.opacity = '0.9';
      const btn = document.createElement('button');
      btn.textContent = authed ? 'Sign out' : 'Sign in';
      btn.style.background = authed ? 'transparent' : '#4f7cff';
      btn.style.color = authed ? '#cbd5ff' : '#fff';
      btn.style.border = authed ? '1px solid #3d4a86' : 'none';
      btn.style.borderRadius = '999px';
      btn.style.padding = '6px 10px';
      btn.style.cursor = 'pointer';
      btn.style.fontWeight = '700';
      btn.onclick = async () => {
        if (authed) {
          // Use the dedicated logout flow page to avoid origin-only returnTo and flicker
          try { window.location.href = '/logout.html'; } catch { window.location.assign('/logout.html'); }
        } else {
          try { await login({}); } catch {}
        }
      };
      el.appendChild(label);
      el.appendChild(btn);
      // If we are already authenticated (e.g., SSO), ensure Authorization patch is applied
      if (authed) { try { attachAuthFetch(); } catch {} }
    } catch {}
  }

  // Auto-render the badge once DOM is ready
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { renderBadge().catch(() => {}); });
    } else {
      // Document already interactive/complete
      Promise.resolve().then(() => renderBadge());
    }
  }
  // Expose for pages that want to re-render after app-specific flows
  window.authClient.renderBadge = renderBadge;
})();
