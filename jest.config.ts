import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  // Node by default: most suites here are server-side. The component suites opt
  // into jsdom with a `@jest-environment jsdom` docblock, which keeps one preset
  // and one transform config for the whole repo rather than duplicating them
  // across `projects`.
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.test.ts', '<rootDir>/test/**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  // Nest's DI reads decorator metadata at class-definition time.
  setupFiles: ['reflect-metadata'],
  testTimeout: 30_000
};

export default config;
