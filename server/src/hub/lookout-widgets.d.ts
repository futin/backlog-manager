/**
 * Type resolution for `lookout-widgets` under this repo's `moduleResolution: "node"` (node10).
 *
 * The package declares its types ONLY through `package.json#exports`, which node10 resolution ignores, so `tsc`, `nest build` and ts-jest cannot find
 * `lookout-widgets` or `lookout-widgets/testkit` even though Node and jest resolve both fine at runtime through that same `exports` map.
 *
 * Why an ambient shim and not `compilerOptions.paths` (#249's plan offered both): `nest build` runs a tsconfig-paths hook that REWRITES every emitted import
 * matching a `paths` entry into a relative path to the mapped file. A `paths` entry pointing at the package's `.d.ts` would therefore turn the built server's
 * `require('lookout-widgets')` into a `require` of a declaration file, and the built server would fail at boot while `tsc --noEmit` and jest stayed green.
 * A shim emits nothing, so the runtime specifier is left exactly as written and Node resolves it through `exports` (the `require` condition, `dist/cjs`).
 *
 * The deep `dist/esm/...` specifiers below are type-only: this is a declaration file, so nothing here survives to runtime, where the package's `exports` map
 * would refuse them. Never import those paths from a `.ts` file. Switching the repo's `moduleResolution` would make this file unnecessary, and is a repo-wide
 * change with its own blast radius.
 */

declare module 'lookout-widgets' {
  export * from 'lookout-widgets/dist/esm/index';
}

declare module 'lookout-widgets/testkit' {
  export * from 'lookout-widgets/dist/esm/testkit/index';
}
