import type { StateTone } from '../../lib/tones';

/**
 * StatusPill — the 28 px state chip of the shell mock (`Shell.dc.html`): a dot in the state's tone, the state word, and optionally how long ago it began.
 *
 * It is a span on purpose and carries no accessible name of its own: every caller wraps it in a button (a session chip, a run chip) that names the whole
 * action, and a name here would be read twice. The dot is `aria-hidden` for the same reason — the word beside it already says what the colour says, so the
 * state never rests on a hue alone. `age` is the caller's already-formatted string; `null` and absent draw nothing rather than an empty gap.
 */
export function StatusPill({ tone, word, age }: { tone: StateTone; word: string; age?: string | null }) {
  return (
    <span className="ui-status">
      <span className="ui-status-dot" data-tone={tone} aria-hidden="true" />
      <span className="ui-status-word">{word}</span>
      {age ? <span className="ui-status-age">{age}</span> : null}
    </span>
  );
}
