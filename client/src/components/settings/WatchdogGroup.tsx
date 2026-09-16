import { useWatchdog } from '../../hooks/useWatchdog';
import { formatSpanCompact } from '../../lib/run-time';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';
import type { WatchdogConfig } from '../../../../shared/types';

/**
 * The watchdog Settings group (design §6.4, trimmed by task-18; drawn to
 * `.claude/DESIGN.md` §8.6 since task-39) — the four knobs, and nothing else.
 *
 * It used to carry a live State row and an Activity feed as well, on the
 * reasoning that the knobs went here so their readings should too. That was
 * wrong in a way one live run made obvious: Settings is a page a person
 * opens to change a preference and leaves, so a 5-second poll and a
 * scrolling event list sat there unread for the whole of a run, while the
 * board — the surface anyone actually watches — said nothing about the
 * sweeper until a run had already crashed. Both moved to Runs › Watchdog
 * (`WatchdogMonitor`), and what stays behind is the `Live view` row below,
 * saying so — and, since task-39, opening it.
 *
 * The rule that move establishes, and that this file is now the reference
 * for: NOTHING IN SETTINGS IS LIVE. Every other group here is a preference —
 * theme, density, default model, link base — read once and acted on. A row
 * that says "next check in 42s" and moves is a monitor, not a setting, and
 * it drags a poll into a page that otherwise has none. Hence
 * `useWatchdog({ live: false })` below: this group renders no text that
 * changes on a clock, so a poll here would redraw identical output forever.
 *
 * The card's scope subtitle says "this server", deliberately, against the
 * "this device" the Local page's cards carry and against the "this machine" of
 * `Claude Agents`, which since task-42 is the card beside this one on Settings'
 * Shared page. (It sat under `Orchestrator · this device` until then, the two
 * being one subject at two scopes; the Local/Shared split traded that adjacency
 * for a page that is honestly one backend throughout, and this card went with
 * the server it writes to.) `this device` really is per-device: `useSettings`
 * writes those to THIS browser's `localStorage`, so opening the board on a
 * phone shows different values than the laptop that set them. `WatchdogConfig` cannot be that — the sweeper it configures
 * runs once, on the API host, with no browser open at all (design §5.1), so
 * `~/.backlog-manager/settings/watchdog.json` is the only copy that exists,
 * read fresh on every tick and every GET. A phone opening this same board
 * reads and writes the identical file the laptop just touched. Naming that
 * plainly in the card's own subtitle — rather than reusing the "this machine"
 * of the card beside it, and letting a reader carry over a meaning it does not
 * have — is the whole point: silently reusing that
 * phrase would be a second thing this group gets wrong for free, on top of
 * the clamp problem the selects below exist to solve.
 *
 * Selects, not number fields, for the three numeric rows. `WATCHDOG_LIMITS`
 * (shared/types.ts) clamps every one of these server-side to `[min, max]`
 * on the NEAREST bound — quietly, no error, no dialog. A free-text or
 * `<input type="number">` field would let someone type `5000` for "Check
 * every" and watch it silently become `30000` the next time this group
 * reloads, with nothing on screen ever having said so: a setting that
 * cannot be seen to fail to stick is worse than one that refuses outright.
 * bug-24 is that same argument arriving from the other direction: the
 * ladders close the CLAMP's silent gap, but a POST the server refuses
 * outright was equally silent until `saveError` below got a render site of
 * its own, because the only `error` render here sits behind `status ===
 * null` — a branch a successful mount GET closes forever.
 * A `<select>` whose options are built from the same `WATCHDOG_LIMITS`
 * triples the server clamps against cannot offer a value the server would
 * ever have to correct — the UI and the clamp read one shared source of
 * truth (`TICK_LADDER`/`GRACE_LADDER`/`ATTEMPT_LADDER` below), so there is
 * no gap for a silent snap to hide in. The one exception that still needs
 * handling is a config value that is NOT on the ladder shown (set by an
 * older build, a hand-edited file, or a future ladder change) — see
 * `ladderWithSelected`'s own comment for why that value is rendered as an
 * extra option instead of the picker silently jumping to a neighbour, which
 * would be exactly the invisible-clamp failure this whole design choice
 * exists to avoid.
 *
 * Every save below posts the ONE field that changed
 * (`useWatchdog.save(patch)` → `POST /api/agents/watchdog/config`) and
 * redraws every row from that POST's own response, never a follow-up GET
 * (design §5.3; `useWatchdog`'s own comment has the full reasoning) — and,
 * when that POST is refused, says so in a row of its own under the control
 * that was changed (`saveErrorSlot`). Rows
 * are not gated on `phase`: a knob is worth setting while nothing is
 * running, so the three selects and the switch render identically whether
 * the sweeper is `off`, `idle` or `armed` — and this group no longer reports
 * which of those it is, so `phase` is now read here for nothing at all.
 */

/**
 * The three ladders, exported so the test can assert programmatically that
 * every option lies inside its `WATCHDOG_LIMITS` entry, rather than the
 * test hand-copying the same five/five/five numbers a second time and
 * silently drifting from what actually ships.
 *
 * RULING R8: `GRACE_LADDER`'s last entry, `3_600_000` (one hour), is
 * labelled by `formatSpanCompact` exactly like every other option in every
 * ladder — there is no hand-written "60m" anywhere in this file.
 * `formatSpanCompact` prints `Xm` only BELOW an hour and delegates to
 * `formatSpan` at or above it, and `formatSpan(3_600_000)` reads `1h 00m`
 * (one hour, zero minutes, padded to two digits) — not `60m`. Design §6.4's
 * prose ladder ("5m 10m 20m 30m 60m") is illustrative, not literal: it
 * predates `formatSpanCompact` being named as the formatter to use, and no
 * test case in the brief asserts the string `60m` anywhere. One formatter
 * used consistently for every option beats a special case carved out for
 * the one option that happens to cross the hour boundary.
 */
export const TICK_LADDER = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
export const GRACE_LADDER = [300_000, 600_000, 1_200_000, 1_800_000, 3_600_000] as const;
export const ATTEMPT_LADDER = [1, 2, 3, 4, 5] as const;

/**
 * A ladder, with the CURRENT config value spliced in and the whole thing
 * numerically sorted — but only when that value is not already one of the
 * ladder's own options. This is the mechanism the whole "selects instead of
 * number fields" argument above depends on: without it, a `tickMs` of
 * `45_000` (set by an older build, hand-edited into `watchdog.json`, or left
 * over from a ladder that used to include it) would force the `<select>`
 * to either silently jump its displayed value to the nearest neighbour —
 * exactly the invisible clamp this design rejects — or lose the value
 * entirely by not appearing as a selected option at all. Splicing it in as
 * its own extra option keeps the true current value visible and selected,
 * `formatSpanCompact`/plain-number labelled like every other option, while
 * every OTHER ladder value still exists to be picked.
 */
function ladderWithSelected(ladder: readonly number[], value: number): number[] {
  return ladder.includes(value) ? [...ladder] : [...ladder, value].sort((a, b) => a - b);
}

/**
 * A ladder as `Select`'s options (task-39): the numbers above, stringified,
 * each labelled by `label`.
 *
 * The stringifying is the primitive's requirement rather than a preference —
 * `Select` is generic over `T extends string` because a native `<option>`'s
 * value IS a string and a component that pretended otherwise would hand every
 * caller back `"30000"` typed as `number`. Doing the conversion here, once,
 * next to the ladder it converts, is what keeps each of the three call sites
 * below to one `Number(...)` on the way out and no cast on the way in.
 */
function ladderOptions(ladder: readonly number[], value: number, label: (v: number) => string): { value: string; label: string }[] {
  return ladderWithSelected(ladder, value).map((v) => ({ value: String(v), label: label(v) }));
}

/** Where a refused save's message goes: the row for the field that was
 *  refused, or the end of the group when there is no such row. */
export type SaveErrorSlot = 'enabled' | 'tickMs' | 'graceMs' | 'maxAttempts' | 'end';

/**
 * The refused field → the row its message is rendered under (bug-24).
 *
 * Exported so its totality can be pinned without a DOM. That totality is the
 * whole point rather than a formality: the defect this function exists to
 * end was a save-failure message with nowhere to render, so the one thing
 * this must never do is return "nowhere". `'end'` is what a `null` field (an
 * empty patch) and any field with no row of its own — a fifth knob added to
 * `WatchdogConfig`, a hand-built patch — both fall back to, so the message
 * still lands somewhere a reader will see it, just without the placement
 * that would have said which setting it was about.
 *
 * Written as an explicit list rather than a `field ?? 'end'` cast, because
 * the cast would claim every present field has a row and quietly produce a
 * slot no JSX below matches — which renders nothing, which is the bug again.
 */
export function saveErrorSlot(field: keyof WatchdogConfig | null): SaveErrorSlot {
  switch (field) {
    case 'enabled':
      return 'enabled';
    case 'tickMs':
      return 'tickMs';
    case 'graceMs':
      return 'graceMs';
    case 'maxAttempts':
      return 'maxAttempts';
    default:
      return 'end';
  }
}

/**
 * The watchdog's own Settings group. Mounted in `SettingsView.tsx`'s right-hand
 * column, under `AgentsGroup` — the two cards that reach off this device.
 *
 * `onOpenWatchdog` is `SettingsView`'s own prop threaded one level further: the
 * `Live view` row below is a real link since task-39, and the destination it
 * opens has to be the rail's own, not a second opinion about where Runs ›
 * Watchdog is. Optional for the reason `SettingsView`'s own signature gives —
 * this suite's cases render the group bare and need no destination.
 */
export function WatchdogGroup({ onOpenWatchdog }: { onOpenWatchdog?: () => void }) {
  // `live: false` — see this file's header: with the State row gone,
  // nothing here changes on a clock, so the armed 5s poll would buy a
  // redraw nobody can see. The mount fetch and the focus refetch stay, and
  // they are what this group actually needs: they are how it learns the
  // config changed on another device.
  const { status, error, saveError, save } = useWatchdog({ live: false });

  // `useWatchdog` never throws — a failed GET lands in `error` and leaves
  // `status` at its initial `null` (see that hook's own comment for why a
  // stale-but-real status is kept on a LATER failure while `null` is kept
  // on the FIRST one). A failed SAVE lands in `saveError` instead and is
  // rendered below, with `status` intact — the two failures are two fields
  // because they need two places on screen. There is no `config` to bind three selects and a
  // checkbox to in that state, so this group renders a one-line notice and
  // nothing else — never a half-built row reading off a value that does
  // not exist, and never a thrown error from dereferencing `status.config`
  // on a `null` status.
  if (status === null) {
    return (
      <SettingsGroup title="Orchestrator watchdog" scope="this server">
        <div className="set-row set-row-stacked">
          <div className="set-label">
            <span className="set-name">Unavailable</span>
            <span className="set-hint">
              Could not reach the watchdog{error ? ` — ${error}` : ''}. This group will fill in once the API answers <code>GET /api/agents/watchdog</code>{' '}
              again.
            </span>
          </div>
        </div>
      </SettingsGroup>
    );
  }

  const { config } = status;

  // A refused POST (bug-24). `status` is intact here and every control below
  // is still showing a real server value, so this is NOT the load failure the
  // `status === null` branch above handles — it is one line saying the change
  // the user just made was refused, rendered beside the control they changed
  // so its position names the setting and the sentence does not have to.
  // Exactly one such row renders, and only when there is a `saveError`:
  // `slot` is a single value, so the `errorRow` guards below are mutually
  // exclusive by construction rather than by four conditions agreeing.
  const slot = saveError === null ? null : saveErrorSlot(saveError.field);
  const errorRow = (at: SaveErrorSlot) =>
    saveError !== null && slot === at ? (
      <div className="set-row set-error-row" role="alert">
        <span className="set-error">Not saved — {saveError.message}. The value shown is the one still on the server.</span>
      </div>
    ) : null;

  return (
    <SettingsGroup title="Orchestrator watchdog" scope="this server">
      {/* A `SettingsRow` since task-39, where this was a control-less div: the
          row now HAS a control, and it is the point of the redraw (DESIGN.md
          §8.6). The sentence used to end by naming Runs › Watchdog and leaving
          the reader to find it; the rail can name that destination now, so this
          row opens it through the rail's own section setter rather than
          describing where it is. One row rather than two because both sentences
          still answer the same question a person arriving here has — where does
          this live, and where do I watch it work. */}
      <SettingsRow
        name="Live view"
        hint={
          <>
            These values live on the API host, in <code>~/.backlog-manager/settings/watchdog.json</code> — not this browser's storage. Every device that opens
            this board reads and writes that same one file, unlike the per-device settings on the Local page. The sweeper's state, the runs it is watching and
            its activity are on Runs › Watchdog.
          </>
        }
      >
        {/* A `<button>`, not an `<a href>`: there is no URL for a section in
            this app — the rail switches a React state — so an anchor would be
            an href this page would have to invent and then cancel on click.
            `.set-link` is the same 36 px family member the dashboard link in
            the card beside it draws. */}
        <button type="button" className="set-link" onClick={() => onOpenWatchdog?.()}>
          Runs › Watchdog ↗
        </button>
      </SettingsRow>

      <SettingsRow
        name="Enabled"
        hint="Your own switch (design's 'Disabled'), separate from the sweeper's own phase: watching, arming and reporting a crashed run all continue either way. Turning this off only withholds the resume spawn itself."
      >
        {/* The pill `Switch` (§8.6), where this was a bare checkbox: a recessed
            `--steel` track under a raised `--strip` option, so "on" is legible
            from the geometry before any colour is read — which matters on the
            amber theme, the one with no second hue to spend on a state. The
            accessible name and the save call are unchanged; what changed is
            that the control is now the same 36 px height as the three selects
            under it, where a UA checkbox was whatever the platform drew. */}
        <Switch label="Enabled" checked={config.enabled} onChange={(enabled) => void save({ enabled })} />
      </SettingsRow>
      {errorRow('enabled')}

      <SettingsRow
        name="Check every"
        hint="How often the sweeper re-reads every project's run file for staleness while armed. Shorter notices a crash sooner; longer costs less on a server watching many projects."
      >
        <Select
          label="Check every"
          value={String(config.tickMs)}
          options={ladderOptions(TICK_LADDER, config.tickMs, formatSpanCompact)}
          onChange={(v) => void save({ tickMs: Number(v) })}
        />
      </SettingsRow>
      {errorRow('tickMs')}

      <SettingsRow
        name="Leave a resumed run alone for"
        hint="How long a crashed run is left alone after any resume attempt or failure before the sweeper tries again. The floor is five minutes: a resume spawned into the same overload that caused the crash can take several minutes just to run its first command."
      >
        <Select
          label="Leave a resumed run alone for"
          value={String(config.graceMs)}
          options={ladderOptions(GRACE_LADDER, config.graceMs, formatSpanCompact)}
          onChange={(v) => void save({ graceMs: Number(v) })}
        />
      </SettingsRow>
      {errorRow('graceMs')}

      <SettingsRow
        name="Give up after"
        hint="How many resume spawns one crashed run gets before the sweeper marks it exhausted and stops trying — past that point the crashed strip's own Resume button is the way forward, by hand."
      >
        <Select
          label="Give up after"
          value={String(config.maxAttempts)}
          options={ladderOptions(ATTEMPT_LADDER, config.maxAttempts, String)}
          onChange={(v) => void save({ maxAttempts: Number(v) })}
        />
      </SettingsRow>
      {errorRow('maxAttempts')}
      {errorRow('end')}
    </SettingsGroup>
  );
}
