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
    if (isAuth) {
      state.user = await state.auth0.getUser();
      // Try to acquire an API access token; if audience is not configured, fall back to ID token
      state.token = await state.auth0.getTokenSilently().catch(() => null);
      try {
        const idc = await state.auth0.getIdTokenClaims();
        state.idTokenRaw = idc && (idc.__raw || idc.raw || null);
      } catch {}
      // Make sure function calls carry Authorization as soon as we detect auth
      try { attachAuthFetch(); } catch {}
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
      // Prefer a freshly refreshed token to avoid expired JWTs in subsequent calls
      state.token = (await state.auth0.getTokenSilently({ cacheMode: 'off' }).catch(() => null))
        || (await state.auth0.getTokenSilently().catch(() => null));
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

  async function getToken() {
    if (state.mode === 'auth0' && state.auth0) {
      // Prefer ID token only if it's still valid; otherwise, acquire a fresh access token.
      const nowSec = Math.floor(Date.now() / 1000);
      const isJwtValid = (raw) => {
        try {
          const parts = String(raw || '').split('.');
          if (parts.length < 2) return false;
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          const exp = Number(payload?.exp || 0);
          return Number.isFinite(exp) && exp > nowSec + 30; // 30s skew
        } catch { return false; }
      };
      try {
        const idc = await state.auth0.getIdTokenClaims();
        const idRaw = (idc && (idc.__raw || idc.raw)) || null;
        if (idRaw && isJwtValid(idRaw)) return idRaw;
      } catch {}
      if (state.idTokenRaw && isJwtValid(state.idTokenRaw)) return state.idTokenRaw;
      // Try to force-refresh the access token
      try {
        const atFresh = await state.auth0.getTokenSilently({ cacheMode: 'off' });
        if (atFresh) return atFresh;
      } catch {}
      try {
        const at = await state.auth0.getTokenSilently();
        if (at) return at;
      } catch {}
      if (state.token) return state.token;
      return null;
    }
    if (state.mode === 'identity' && window.netlifyIdentity) {
      const u = window.netlifyIdentity.currentUser();
      return await u?.jwt?.();
    }
    return null;
  }

  // Explicit helper to always send Authorization for first-party function calls
  async function authFetch(input, init = {}) {
    try { await ensureAuth(); } catch {}
    const headers = Object.assign({}, init.headers);
    try {
      const token = await getToken();
      if (token) headers.Authorization = headers.Authorization || `Bearer ${token}`;
    } catch {}
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
          const token = state.token || (await getToken());
          if (token) {
            init.headers = Object.assign({}, init.headers, {
              Authorization: init.headers?.Authorization || `Bearer ${token}`,
            });
          }
        }
      } catch {}
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
