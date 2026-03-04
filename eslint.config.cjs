const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.out/**',
      '**/.netlify/**',
      '**/.eslintcache',
      '**/coverage/**',
      '**/public/**',
      '**/static/**',
      '**/generated/**',
      '**/__generated__/**',
      '**/*.{png,jpg,jpeg,gif,svg,webp,ico}',
      '**/*.{pdf,zip,tar,rar}'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        setTimeout: 'readonly',
        fetch: 'readonly',
        window: 'readonly',
        document: 'readonly'
      }
    },
    rules: {
  'no-unused-vars': 'off',
  'prefer-const': 'off',
  '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      '@typescript-eslint/ban-ts-comment': 'off'
    }
  },

  // ── Layer-boundary rules (run separately via `npm run lint:boundaries`) ──
  //
  // packages/core and packages/shared are platform-agnostic and must never
  // import from apps/* (which is framework-specific Express/web code).
  {
    files: ['packages/**/*.ts', 'packages/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            // Catch relative paths that traverse up from packages/ into apps/
            // e.g. ../../apps/api/src/...  or  ../../../apps/web/src/...
            regex: '(\\.\\.\\/)+apps\\/',
            message:
              'packages/* must not import from apps/*. ' +
              'Move shared logic to packages/core/src/ or src/services/ instead.'
          }
        ]
      }]
    }
  },

  // apps/api Express routes must not reach into netlify/functions/*.
  // The PowerShell check (check:no-netlify) catches @netlify imports;
  // this rule catches direct relative path imports of function files.
  {
    files: ['apps/api/**/*.ts', 'apps/api/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            // Catch relative paths that traverse up from apps/api into netlify/
            // e.g. ../../../../netlify/functions/ebay-create-draft
            regex: '(\\.\\.\\/)+netlify\\/',
            message:
              'apps/api/* must not import from netlify/functions/*. ' +
              'Extract shared logic into src/services/ and import from there.'
          }
        ]
      }]
    }
  }
];
