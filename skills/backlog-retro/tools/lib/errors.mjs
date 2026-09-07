// The one error class this tool throws on purpose, in its own module so the
// lib/ modules can throw it without importing retro.mjs (which imports
// them — a cycle that would work by accident and break the first time
// somebody reordered an import). `retro.mjs` re-exports it, so the CLI's
// public surface is still `RetroError` from `retro.mjs`.
//
// The code IS the process exit status; see retro.mjs's header for what each
// number means and why 2 and 3 are not 1.
export class RetroError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RetroError'
    this.code = code
  }
}
