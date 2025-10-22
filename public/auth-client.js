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
    auth0: null,
    identityReady: false,
    token: null,
    user: null,
  };

  async function loadConfig() {
    try {
      const res = await fetch('/.netlify/functions/get-public-config');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'config');
      state.cfg = j;
      state.mode = (j.AUTH_MODE || 'none').toLowerCase();
    } catch (e) {
      console.warn('Auth config missing; continuing unauthenticated', e);
      state.mode = 'none';
      state.cfg = {};
    }
  }

  async function initAuth0() {
    if (!state.cfg?.AUTH0_DOMAIN || !state.cfg?.AUTH0_CLIENT_ID) return;
    if (state.auth0) return;
    // Load SPA SDK if not present. Prefer same-origin proxy to satisfy strict CSP.
    async function loadSdk(url) {
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = reject;
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
      state.token = await state.auth0.getTokenSilently().catch(() => null);
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
      state.token = await state.auth0.getTokenSilently().catch(() => null);
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

  async function logout() {
    await loadConfig();
    if (state.mode === 'auth0' && state.auth0) {
      await state.auth0.logout({ logoutParams: { returnTo: window.location.origin } });
      return;
    }
    if (state.mode === 'identity' && window.netlifyIdentity) {
      window.netlifyIdentity.logout();
      window.location.reload();
      return;
    }
  }

  async function getToken() {
    if (state.mode === 'auth0' && state.auth0) {
      try {
        return await state.auth0.getTokenSilently();
      } catch {
        return null;
      }
    }
    if (state.mode === 'identity' && window.netlifyIdentity) {
      const u = window.netlifyIdentity.currentUser();
      return await u?.jwt?.();
    }
    return null;
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

  window.authClient = { requireAuth, login, logout, getToken, ensureAuth };
})();
