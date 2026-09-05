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
  //
  // `test/helpers/env.ts` runs alongside it, before any module under test is
  // imported, and defaults `BM_WATCHDOG=off` for every suite. That is not a
  // convenience: without it, any suite that builds `AppModule` arms the
  // orchestrator watchdog, whose bootstrap scan reads the DEVELOPER'S REAL
  // `~/.backlog-manager/orchestrator/` directory unless the suite overrode
  // `BM_ORCH_HOME` — and a crashed run sitting there would make `pnpm test`
  // spawn a real agent session against the developer's own repo. See that
  // file's own header for the full reasoning.
  setupFiles: ['reflect-metadata', '<rootDir>/test/helpers/env.ts'],
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
