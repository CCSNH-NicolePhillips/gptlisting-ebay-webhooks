# Internal Functions (Not Deployed)

This folder contains functions that are **NOT deployed to Netlify**.

These are internal tooling, diagnostics, migrations, and test utilities that should only be run manually or in development.

## Categories

### Diagnostics (`diag-*`)
Functions for debugging and inspecting system state.

### Debug Tools (`debug-*`)
Development-only debugging endpoints.

### Admin Tools (`admin-*`)
Manual administrative utilities (not for production API).

### Migrations (`migrate-*`)
One-off data migration scripts.

### Exports (`export-*`)
Data export utilities.

### Tests (`test-*`)
Test endpoints for development.

## Why Not Deploy These?

1. **Security**: Admin/debug tools shouldn't be publicly accessible
2. **Cost**: Each function adds memory overhead during Netlify packaging
3. **Maintenance**: Internal tools don't need production deployment

## Running Internal Functions

To run these locally:
```bash
netlify dev
```

Then access via `http://localhost:8888/.netlify/functions/function-name`
