import type { StateTone } from '../../lib/tones';

/** What each tone says to a screen reader in place of the dot: the shell Jira chip's readings (`serviceTone`), plus `red` for a sweep that failed. */
const POLL_WORD: Record<StateTone, string> = { green: 'on time', amber: 'late', red: 'failing', grey: 'sync off' };

/**
 * PollAge — a source's freshness in the Jira band (.claude/DESIGN.md §8.9.1, the band; mock A "fact pills", 2026-11-18): a 7 px dot in the source's tone, then
 * its age, `1m ago`. Drawn twice on one row, after the Jira facts and after the GitLab ones, so it is a primitive rather than a page class.
 *
 * The visible text drops the word `polled` — the dot's place on the row already says what the age is of — and the `title` and the hidden words put it back,
 * so hover and a screen reader still read `polled 1m ago`, and the tone is never a hue alone. A source that has never been read has no age: `polled` is then
 * the whole visible text (`not polled yet`), since a dot beside nothing would say nothing.
 *
 * The dot reuses `StatusPill`'s colours (`.ui-status-dot`'s tones at the same 7 px), restated here rather than borrowed because guard 7 forbids one family's
 * selector reaching into another's.
 */
export function PollAge({ tone, age, polled }: { tone: StateTone; age: string | null; polled: string }) {
  return (
    <span className="ui-poll" title={polled}>
      <span className="ui-poll-dot" data-tone={tone} aria-hidden="true" />
      {age === null ? (
        polled
      ) : (
        <>
          <span className="sr-only">{POLL_WORD[tone]}, polled </span>
          {age}
        </>
      )}
    </span>
  );
}
