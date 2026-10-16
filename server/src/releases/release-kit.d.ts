/**
 * Type resolution for `release-kit` under this repo's `moduleResolution: "node"` (node10) — the reason, and the reason it is an ambient shim rather than a
 * `compilerOptions.paths` entry, are `server/src/hub/lookout-widgets.d.ts`'s: the package declares its types only through `package.json#exports`, which
 * node10 ignores, and a `paths` entry would be rewritten by `nest build` into a `require` of a declaration file. A shim emits nothing, so the runtime
 * `require('release-kit')` resolves through `exports` (the `require` condition, `dist/cjs`).
 *
 * `server/src` imports only the pure `parseTagMessage` from it; `readReleases` launches git outside `runGit` and is for tests only (spec R4).
 */

declare module 'release-kit' {
  export * from 'release-kit/dist/esm/index';
}
