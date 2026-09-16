export type DotTone = 'live' | 'paused' | 'crashed' | 'done' | 'ramp-refactors' | 'ramp-ideas' | 'ramp-bugs' | 'ramp-tasks';

/**
 * Dot — §7's legend dot (.claude/DESIGN.md §7, §8.2, §8.3, §8.8).
 *
 * One filled circle at 8 px (10 px where it leads a row), carrying either a
 * status tone or a project hue. It is `aria-hidden` unconditionally and has no
 * text of its own: every place this board draws one, the word it belongs to is
 * already beside it, and a dot that announced itself would read the status
 * twice.
 *
 * `hue` resolves through `lib/project-hue.ts` exactly as `.pill-proj-N` does
 * today — the colour arrives as a CLASS, never a `style` attribute, so a theme
 * swap recolours every dot on the board for free (§8.2). `tone` and `hue` are
 * mutually exclusive by construction: a dot says a status or an identity, and
 * one that said both would be two encodings on one 8 px circle.
 *
 * `breathe` is §8.8's one motion mechanism for a live dot, landed here rather
 * than as an animation local to the run chip, so any other live dot earns the
 * same ring for free. It is silenced under `prefers-reduced-motion` by this
 * family's own explicit `animation: none` in the stylesheet — not by the
 * blanket rule, which freezes an animation on its LAST keyframe rather than
 * cancelling it.
 *
 * **No tone is a reading, not a missing prop** (task-37). `.ui-dot`'s base rule
 * paints `--ink3`, and that quiet grey is the honest answer for a dot whose
 * subject is in no state worth colouring — the run chip's, when every run in
 * the payload has finished. Before this, the nearest thing the props could say
 * was `done`, which is `--fill-progress`: the exact token §8.3 gives a LIVE
 * run, so a board with nothing running drew the same green as one mid-run. The
 * cost of the optional prop is that a mistyped tone name now paints the quiet
 * dot instead of failing to compile; the alternative was a ninth tone whose
 * rule would have duplicated the base's one declaration, which is the synonym
 * §8.2 rules out for tokens.
 */
export function Dot(props: { size?: 8 | 10; breathe?: boolean } & ({ tone?: DotTone } | { hue: number })) {
  const { size = 8, breathe } = props;
  /* Keyed on `hue` rather than on `tone`, which is the swap the optional prop
     forces: `'tone' in props` is false for `<Dot />` AND for a hue dot, so the
     branch has to test the one member that is still required when it is
     present. */
  const paint = 'hue' in props ? `ui-dot-proj-${props.hue}` : props.tone ? `ui-dot-${props.tone}` : null;
  const className = ['ui-dot', paint, size === 10 ? 'ui-dot-10' : 'ui-dot-8', breathe ? 'ui-dot-breathe' : null].filter(Boolean).join(' ');
  return <span className={className} aria-hidden="true" />;
}
