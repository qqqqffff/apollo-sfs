/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jest-environment-jsdom',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.jest.json',
      // Suppress type-check errors during the test run — tsc --noEmit handles
      // type correctness separately. This keeps the test output focused on
      // test failures rather than type errors.
      diagnostics: false,
    }],
  },
  // react-icons v5 ships ESM — transform it through ts-jest so Jest can load it.
  transformIgnorePatterns: ['node_modules/(?!(react-icons)/)'],
  // Polyfills that must be available before any test module loads.
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
  moduleNameMapper: {
    // Static assets (images, SVGs, CSS) have no runtime meaning in tests.
    '\\.(css|svg|png|jpg|jpeg|gif|webp|ico|mp4|webm|ogg|mp3|wav)$':
      '<rootDir>/src/__mocks__/fileMock.cjs',
  },
  testMatch: [
    '**/__tests__/**/*.{ts,tsx}',
    '**/*.{spec,test}.{ts,tsx}',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/src/__tests__/setup\\.ts$', '/src/__tests__/e2e/'],
  collectCoverageFrom: [
    'src/api/**/*.{ts,tsx}',
    'src/components/**/*.{ts,tsx}',
    'src/routes/**/*.{ts,tsx}',
    'src/context/**/*.{ts,tsx}',
    'src/hooks/**/*.{ts,tsx}',
  ],
  coverageReporters: ['text', 'lcov'],
};
