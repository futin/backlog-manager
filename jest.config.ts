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
  testTimeout: 30_000,
  // marked ships ESM-only (package.json "type": "module", no cjs entry), but
  // ts-jest compiles this repo's own code to CommonJS, so a plain `require`
  // of the package hits its .esm.js file and Jest chokes on the bare `export`
  // syntax. The package's own UMD build is the escape hatch: it feature-tests
  // `module.exports` at load time and behaves as a normal CJS module when
  // found. Test-only — Vite resolves the real ESM entry for the client build.
  moduleNameMapper: {
    '^marked$': '<rootDir>/node_modules/marked/lib/marked.umd.js'
  }
};

export default config;
