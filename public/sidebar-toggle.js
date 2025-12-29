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
    
    // Add title attributes to all nav items for hover tooltips
    const navItems = sidebar.querySelectorAll('.dp-nav-item');
    navItems.forEach(function(item) {
      if (!item.hasAttribute('title')) {
        const label = item.querySelector('.dp-nav-item__label');
        if (label) {
          item.setAttribute('title', label.textContent.trim());
        }
      }
    });
    
    // Create toggle button if it doesn't exist
    let toggle = sidebar.querySelector('.dp-sidebar__toggle');
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.className = 'dp-sidebar__toggle';
      toggle.setAttribute('aria-label', 'Toggle sidebar');
      toggle.setAttribute('title', 'Close sidebar');
      toggle.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="9" y1="3" x2="9" y2="21"></line>
        </svg>
      `;
      // Insert toggle at the start of sidebar (will be positioned absolutely)
      sidebar.insertBefore(toggle, sidebar.firstChild);
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
