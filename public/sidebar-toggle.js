/**
 * Sidebar Toggle - Collapsible sidebar functionality
 * Include this script in any page with a dp-sidebar
 */
(function() {
  'use strict';
  
  const STORAGE_KEY = 'dp-sidebar-collapsed';
  
  function initSidebarToggle() {
    const sidebar = document.querySelector('.dp-sidebar');
    const shell = document.querySelector('.dp-shell');
    
    if (!sidebar || !shell) return;
    
    // Create toggle button if it doesn't exist
    let toggle = sidebar.querySelector('.dp-sidebar__toggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.className = 'dp-sidebar__toggle';
      toggle.setAttribute('aria-label', 'Toggle sidebar');
      toggle.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      `;
      sidebar.appendChild(toggle);
    }
    
    // Create collapsed logo placeholder in brand area
    const brandArea = sidebar.querySelector('.dp-sidebar__brand');
    if (brandArea && !brandArea.querySelector('.dp-sidebar__collapsed-logo')) {
      const collapsedLogo = document.createElement('div');
      collapsedLogo.className = 'dp-sidebar__collapsed-logo';
      collapsedLogo.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
        </svg>
      `;
      brandArea.appendChild(collapsedLogo);
    }
    
    // Restore saved state
    const isCollapsed = localStorage.getItem(STORAGE_KEY) === 'true';
    if (isCollapsed) {
      sidebar.classList.add('dp-sidebar--collapsed');
      shell.classList.add('dp-sidebar-collapsed');
    }
    
    // Toggle handler
    toggle.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      
      const collapsed = sidebar.classList.toggle('dp-sidebar--collapsed');
      shell.classList.toggle('dp-sidebar-collapsed', collapsed);
      
      // Save state
      localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
    });
  }
  
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebarToggle);
  } else {
    initSidebarToggle();
  }
})();
