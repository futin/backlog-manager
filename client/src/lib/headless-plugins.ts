import { HEADLESS_PLUGINS_MAX, HEADLESS_PLUGIN_SHAPE } from '../../../shared/agent';

/**
 * headless-plugins.ts — the Settings card's derivations over the plugin allowlist (#625), kept out of the component so they have one home (board.md: every
 * derivation lives in `lib/`).
 */

/** Kept whatever the list says — the session's own `/backlog-execute` lives in it — so the card draws it first, locked, whether or not the file names it. */
export const HEADLESS_LOCKED_PLUGIN = 'backlog-manager';

/** The chips in drawing order: the locked plugin first, then the list as stored, without a second copy of the locked one. */
export function headlessChips(plugins: readonly string[]): string[] {
  return [HEADLESS_LOCKED_PLUGIN, ...plugins.filter((p) => p !== HEADLESS_LOCKED_PLUGIN)];
}

/**
 * The list after adding `typed` (trimmed), or the sentence saying why not. Checked against the same shape and cap the server enforces, so the card never
 * POSTs a body that can only come back a 400. Adding a name already on the list (or the locked one) is a no-op, not an error.
 */
export function addHeadlessPlugin(plugins: readonly string[], typed: string): { ok: true; plugins: string[] } | { ok: false; error: string } {
  const name = typed.trim();
  if (name === '') return { ok: false, error: 'Type a plugin name first.' };
  if (!HEADLESS_PLUGIN_SHAPE.test(name)) return { ok: false, error: `“${name}” is not a plugin name — letters, digits, . _ - and at most one @marketplace.` };
  if (plugins.includes(name) || name === HEADLESS_LOCKED_PLUGIN) return { ok: true, plugins: [...plugins] };
  if (plugins.length >= HEADLESS_PLUGINS_MAX) return { ok: false, error: `At most ${HEADLESS_PLUGINS_MAX} plugins.` };
  return { ok: true, plugins: [...plugins, name] };
}

/** The list without `name`; the locked plugin is never removed. */
export function removeHeadlessPlugin(plugins: readonly string[], name: string): string[] {
  return name === HEADLESS_LOCKED_PLUGIN ? [...plugins] : plugins.filter((p) => p !== name);
}
