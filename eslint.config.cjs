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
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
