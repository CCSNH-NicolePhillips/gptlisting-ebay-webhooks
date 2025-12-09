/**
 * DraftPilot Sidebar Shell
 * Injects the sidebar + topbar layout into any page
 * 
 * Usage:
 * 1. Add <link rel="stylesheet" href="/draftpilot.css"> to <head>
 * 2. Add <script src="/sidebar-shell.js"></script> before </body>
 * 3. Wrap your content in <div id="pageContent">...</div>
 * 4. Call DraftPilotShell.init({ title: 'Page Title', subtitle: 'Description', activePage: 'overview' });
 */

window.DraftPilotShell = {
  init: function(options = {}) {
    const {
      title = 'DraftPilot',
      subtitle = 'Welcome back',
      activePage = 'overview', // 'overview', 'create-listings', 'drafts'
      showSearch = false
    } = options;

    // Get the page content
    const pageContent = document.getElementById('pageContent');
    if (!pageContent) {
      console.error('[DraftPilotShell] No element with id="pageContent" found');
      return;
    }

    // Extract the content
    const contentHTML = pageContent.innerHTML;
    pageContent.innerHTML = '';

    // Build the shell
    const shellHTML = `
      <!-- Loading State -->
      <div class="dp-card" id="dpLoadingCard" style="display:block; text-align:center; max-width: 400px; margin: 100px auto; padding: 40px;">
        <h1 style="margin-bottom: 16px;">Loading…</h1>
        <p class="dp-muted">Preparing your workspace</p>
      </div>

      <!-- Main Shell -->
      <div class="dp-shell" id="dpMainCard" style="display:none;">
        <!-- Sidebar -->
        <aside class="dp-sidebar">
          <div class="dp-sidebar__brand">
            <img src="/logo/LogoWhiteText_NoBg.png" alt="DraftPilot" class="dp-brand-logo" />
          </div>
          
          <nav class="dp-sidebar__nav">
            <div class="dp-nav-group">
              <div class="dp-nav-group__label">APP</div>
              <div class="dp-nav-group__items">
                <a href="/index.html" class="dp-nav-item ${activePage === 'overview' ? 'dp-nav-item--active' : ''}">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                    <polyline points="9 22 9 12 15 12 15 22"></polyline>
                  </svg>
                  <span class="dp-nav-item__label">Overview</span>
                </a>
                <a href="/quick-list.html" class="dp-nav-item ${activePage === 'create-listings' ? 'dp-nav-item--active' : ''}">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                  </svg>
                  <span class="dp-nav-item__label">Create Listings</span>
                </a>
                <a href="/drafts.html" class="dp-nav-item ${activePage === 'drafts' ? 'dp-nav-item--active' : ''}">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                  </svg>
                  <span class="dp-nav-item__label">Drafts</span>
                </a>
                <a href="/active-listings.html" class="dp-nav-item ${activePage === 'active-listings' ? 'dp-nav-item--active' : ''}">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
                  </svg>
                  <span class="dp-nav-item__label">Active Listings</span>
                </a>
              </div>
            </div>
            
            <div class="dp-nav-group">
              <div class="dp-nav-group__label">ACCOUNT</div>
              <div class="dp-nav-group__items">
                <a href="/policies-manage.html" class="dp-nav-item">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                  </svg>
                  <span class="dp-nav-item__label">eBay Policies</span>
                </a>
                <a href="/location.html" class="dp-nav-item">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                  </svg>
                  <span class="dp-nav-item__label">Inventory Locations</span>
                </a>
                <a href="/settings.html" class="dp-nav-item">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M12 1v6m0 6v6m5.196-15.196l-4.243 4.243m0 5.656l-4.242 4.243m15.195-5.196l-4.242-4.243m-5.657 0l-4.243-4.243"></path>
                  </svg>
                  <span class="dp-nav-item__label">Settings</span>
                </a>
                <a href="/faq.html" class="dp-nav-item">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                  <span class="dp-nav-item__label">FAQ</span>
                </a>
                <a href="/support.html" class="dp-nav-item">
                  <svg class="dp-nav-item__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                  <span class="dp-nav-item__label">Support</span>
                </a>
              </div>
            </div>
          </nav>
          
          <div class="dp-sidebar__spacer"></div>
          
          <div class="dp-sidebar__footer">
            <div class="dp-user-card">
              <div class="dp-user-card__avatar" id="dpUserAvatar">U</div>
              <div class="dp-user-card__info">
                <div class="dp-user-card__name" id="dpUserName">User</div>
                <div class="dp-user-card__status">Signed in</div>
              </div>
            </div>
          </div>
        </aside>
        
        <div class="dp-mobile-backdrop" id="dpMobileBackdrop"></div>
        
        <!-- Main Content Wrapper -->
        <div class="dp-main-wrapper">
          <!-- Top Bar -->
          <header class="dp-topbar">
            <div class="dp-topbar-left">
              <button class="dp-topbar-icon dp-topbar-icon--menu" id="dpMobileMenuButton" aria-label="Open navigation" type="button">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="4" y1="6" x2="20" y2="6"></line>
                  <line x1="4" y1="12" x2="20" y2="12"></line>
                  <line x1="4" y1="18" x2="20" y2="18"></line>
                </svg>
              </button>
              <div class="dp-topbar-heading">
                <h1 class="dp-topbar__title">${title}</h1>
                <p class="dp-topbar__subtitle">${subtitle}</p>
              </div>
            </div>
            ${showSearch ? `
            <div class="dp-topbar-center">
              <div class="dp-search">
                <svg class="dp-search__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input type="text" class="dp-search__input" placeholder="Search..." />
              </div>
            </div>
            ` : ''}
          </header>
          
          <!-- Main Content -->
          <main class="dp-main" id="dpPageContent">
            ${contentHTML}
          </main>
        </div>
      </div>
    `;

    // Replace body content
    pageContent.outerHTML = shellHTML;

    // Show main card after brief delay
    setTimeout(() => {
      const loading = document.getElementById('dpLoadingCard');
      const main = document.getElementById('dpMainCard');
      if (loading) loading.style.display = 'none';
      if (main) main.style.display = 'flex';
    }, 100);

    // Setup mobile menu
    const menuBtn = document.getElementById('dpMobileMenuButton');
    const sidebar = document.querySelector('.dp-sidebar');
    const backdrop = document.getElementById('dpMobileBackdrop');
    
    if (menuBtn && sidebar && backdrop) {
      menuBtn.addEventListener('click', () => {
        sidebar.classList.toggle('dp-sidebar--open');
        backdrop.classList.toggle('dp-mobile-backdrop--visible');
      });
      backdrop.addEventListener('click', () => {
        sidebar.classList.remove('dp-sidebar--open');
        backdrop.classList.remove('dp-mobile-backdrop--visible');
      });
    }

    // Update user info if available
    if (window.authClient) {
      authClient.ensureAuth().then(ok => {
        if (ok) {
          authClient.authFetch('/.netlify/functions/me').then(r => r.json()).then(data => {
            const nameEl = document.getElementById('dpUserName');
            const avatarEl = document.getElementById('dpUserAvatar');
            if (data.email && nameEl) {
              nameEl.textContent = data.email.split('@')[0];
            }
            if (data.email && avatarEl) {
              avatarEl.textContent = data.email.charAt(0).toUpperCase();
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  }
};
