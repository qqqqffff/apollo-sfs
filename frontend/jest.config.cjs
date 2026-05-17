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
  moduleNameMapper: {
    // Static assets (images, SVGs, CSS) have no runtime meaning in tests.
    '\\.(css|svg|png|jpg|jpeg|gif|webp|ico|mp4|webm|ogg|mp3|wav)$':
      '<rootDir>/src/__mocks__/fileMock.cjs',
  },
  testMatch: [
    '**/__tests__/**/*.{ts,tsx}',
    '**/*.{spec,test}.{ts,tsx}',
  ],
};
