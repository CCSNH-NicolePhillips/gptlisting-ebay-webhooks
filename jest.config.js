export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Path aliases — must come before the .js extension mapper
    '^@core/(.*)$': '<rootDir>/packages/core/src/$1',
    '^@shared/(.*)$': '<rootDir>/packages/shared/src/$1',
    '^@api/(.*)$': '<rootDir>/apps/api/src/$1',    // Redirect node-fetch v3 (pure ESM) to native fetch so Jest doesn't choke
    // on the ESM import syntax inside node_modules/node-fetch/src/index.js.
    '^node-fetch$': '<rootDir>/__mocks__/node-fetch.js',    // Strip .js extensions for ESM compatibility
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'node',
        },
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.d\\.ts$'
  ],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '\\.d\\.ts$'],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 62,
      lines: 62,
      statements: 61,
    },
  },
  forceExit: true,
};
