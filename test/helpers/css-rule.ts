import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The one stylesheet every rule-level assertion in this suite reads. */
export const STYLES = join(__dirname, '..', '..', 'client', 'src', 'styles.css');

export function readStyles(): string {
  return readFileSync(STYLES, 'utf8');
}

/**
 * Returns the declarations inside `selector`'s rule, or `null` if the selector
 * has no rule in the sheet at all. Deliberately not a `[^}]*` regex over the
 * whole file: that would also match a selector that merely *contains* this one
 * as a prefix, and it would silently return the wrong block if the rule were
 * ever moved after a similarly-named neighbour. The boundary check on the
 * character before/after the selector is what makes "found" mean this rule and
 * not a longer class name that happens to start the same way.
 *
 * Extracted from run-drawer-tail-style.test.ts, which is still its first
 * caller — a second stylesheet suite (the stage chip's tones) needs the exact
 * same boundary-aware lookup, and two copies of a parser this fiddly would
 * drift the moment one of them was fixed.
 */
export function ruleBlock(css: string, selector: string): string | null {
  const all = ruleBlocks(css, selector);
  return all.length === 0 ? null : all[0];
}

/**
 * Every rule whose selector list mentions `selector`, in source order.
 *
 * `ruleBlock` returning only the first is a real trap once a class appears in
 * more than one rule: `.board-card-stage-done` is named both by its own tone
 * rule and, as an ancestor, by the rule that cancels the glyph pulse for
 * non-active tones — and the cancel rule comes first in the sheet, so asking
 * for "the" block got a rule with no `color` in it and a test failed for a
 * reason that had nothing to do with the styling it was checking. A caller
 * that needs a specific declaration should search all of them.
 */
export function ruleBlocks(css: string, selector: string): string[] {
  const boundary = /[\s,{]/;
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(selector, from);
    if (at === -1) return found;
    from = at + selector.length;
    const before = at === 0 ? '\n' : css[at - 1];
    const after = css[from] ?? '';
    // A selector token ends at whitespace, a comma or the opening brace; a
    // letter, digit or hyphen after it means we matched a prefix of a longer
    // class name (`-tail-wrapper`), not this selector.
    if (!boundary.test(before) || !boundary.test(after)) continue;
    const open = css.indexOf('{', from);
    const close = css.indexOf('}', open);
    if (open === -1 || close === -1) return found;
    found.push(css.slice(open + 1, close));
    from = close + 1;
  }
}
