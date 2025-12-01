# Shell Normalization - December 1, 2025

## What We Did

Implemented a **unified app shell system** across all three main pages (index.html, quick-list.html, drafts.html) to ensure consistent layout, navigation, and scroll behavior.

## Changes Made (Commit: 614151d)

### 1. CSS - New Shell System (`draftpilot.css`)

Added comprehensive new layout classes:

**Core Shell Structure:**
- `.dp-shell` - Root flex container (height: 100vh, overflow: hidden)
- `.dp-shell__sidebar` - Fixed 260px sidebar (scrollable)
- `.dp-shell__main` - Main content area (flex column)
- `.dp-shell__header` - Pinned header with backdrop blur
- `.dp-shell__content` - Scrollable content area (padding: 1.5rem)
- `.dp-page` - Content wrapper (max-width: 1120px)

**Header Components:**
- `.dp-shell__brand` - Logo area container
- `.dp-logo-mark` - Circular "DP" logo badge (32px)
- `.dp-logo-text` - "DraftPilot" wordmark
- `.dp-shell__header-right` - Right side header content
- `.dp-user-pill` - User info display

**Page Header (in content):**
- `.dp-page-header` - Content area page header
- `.dp-page-title` - 2rem page title
- `.dp-page-subtitle` - 1rem subtitle with muted color

**Mobile Responsive:**
- Sidebar transforms to full-screen slide-in drawer on mobile
- `.dp-shell__sidebar--open` class for mobile drawer state
- Content padding reduces to 1rem on mobile

### 2. HTML Structure Changes

**All Three Pages Now Use:**

```html
<div class="dp-shell">
  <aside class="dp-shell__sidebar">
    <!-- Sidebar with navigation -->
  </aside>
  
  <div class="dp-shell__main">
    <header class="dp-shell__header">
      <div class="dp-shell__brand">
        <div class="dp-logo-mark">DP</div>
        <div class="dp-logo-text">DraftPilot</div>
      </div>
      <div class="dp-shell__header-right">
        <div class="dp-user-pill"></div>
      </div>
    </header>
    
    <main class="dp-shell__content">
      <div class="dp-page">
        <header class="dp-page-header">
          <h1 class="dp-page-title">Page Name</h1>
          <p class="dp-page-subtitle">Description</p>
        </header>
        
        <!-- Page content here -->
      </div>
    </main>
  </div>
</div>
```

### 3. Specific Page Changes

**index.html (Dashboard):**
- Wrapped in `.dp-shell`
- Changed `.dp-app` → `.dp-shell`
- Changed `.dp-sidebar` → `.dp-shell__sidebar`
- Added `.dp-shell__header` with DP logo + DraftPilot text
- Moved "Dashboard" title from header chrome to `.dp-page-header` in content
- Simplified subtitle to "Welcome back, seller."

**quick-list.html:**
- Wrapped in `.dp-shell`
- Added normalized header with DP branding
- Moved "Quick List" title to `.dp-page-header` in content
- Updated subtitle: "Upload product photos and turn them into AI-ready eBay drafts."
- Kept gradient hero card with feature tags and upload toggle

**drafts.html:**
- Complete restructure from old layout
- Added normalized shell structure
- Created `<section class="drafts-toolbar">` for action buttons
- Created `<section class="drafts-lists">` for draft lists
- Moved "Drafts" title to `.dp-page-header` in content
- Preserved all JavaScript IDs: `readyList`, `attentionList`, `dp-drafts-root`, etc.

## Key Design Decisions

1. **Page titles in content, not chrome**: Header bar only shows DP logo + "DraftPilot" brand. Actual page titles ("Dashboard", "Quick List", "Drafts") appear in the scrollable content area.

2. **Viewport-locked scrolling**: Only `.dp-shell__content` scrolls. Sidebar and header stay fixed.

3. **Consistent branding**: All pages show identical header with circular DP logo mark + DraftPilot wordmark.

4. **Mobile-first responsive**: CSS structure supports mobile drawer navigation (JS toggle not yet implemented).

5. **Backward compatibility**: Kept legacy `.dp-sidebar` class alongside new `.dp-shell__sidebar` for gradual migration.

## What Still Needs Work

1. **Mobile navigation toggle**: CSS is ready, but JavaScript for hamburger menu not implemented
2. **User pill content**: Currently empty `<div class="dp-user-pill"></div>` - needs actual user info
3. **Gradient hero card**: Only on quick-list.html - consider adding to other pages if desired
4. **Logo assets**: Currently using placeholder "DP" text - replace with actual logo image if available

## Technical Notes

- **Scroll behavior**: `html, body { height: 100%; overflow: hidden; }` prevents double scrollbars
- **Flexbox layout**: `.dp-shell` uses flexbox for sidebar + main layout
- **Content constraint**: `.dp-page` max-width keeps content readable on ultrawide screens
- **Mobile breakpoint**: 768px - sidebar becomes full-screen drawer below this

## Files Modified

- `public/draftpilot.css` (+200 lines new shell CSS)
- `public/index.html` (restructured)
- `public/quick-list.html` (restructured)
- `public/drafts.html` (complete rewrite)

**Total**: 4 files changed, 452 insertions(+), 2330 deletions

---

## For Next Session

If you need to add more pages or modify the shell:

1. Copy the shell structure from any of the three pages
2. Change only the page title/subtitle in `.dp-page-header`
3. Add your page-specific content inside `.dp-page`
4. Keep all wrapper structure identical for consistency

The shell system is now the standard for all main app pages.
