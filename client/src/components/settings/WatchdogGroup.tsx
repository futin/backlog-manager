import { useWatchdog } from '../../hooks/useWatchdog';
import { formatSpanCompact } from '../../lib/run-time';
import { SettingsGroup, SettingsRow } from './SettingsRow';

/**
 * The watchdog Settings group (design §6.4, trimmed by task-18) — the four
 * knobs, and nothing else.
 *
 * It used to carry a live State row and an Activity feed as well, on the
 * reasoning that the knobs went here so their readings should too. That was
 * wrong in a way one live run made obvious: Settings is a page a person
 * opens to change a preference and leaves, so a 5-second poll and a
 * scrolling event list sat there unread for the whole of a run, while the
 * board — the surface anyone actually watches — said nothing about the
 * sweeper until a run had already crashed. Both moved to Runs › Watchdog
 * (`WatchdogMonitor`), and what stays behind is the `Live view` row below,
 * saying so.
 *
 * The rule that move establishes, and that this file is now the reference
 * for: NOTHING IN SETTINGS IS LIVE. Every other group here is a preference —
 * theme, density, default model, link base — read once and acted on. A row
 * that says "next check in 42s" and moves is a monitor, not a setting, and
 * it drags a poll into a page that otherwise has none. Hence
 * `useWatchdog({ live: false })` below: this group renders no text that
 * changes on a clock, so a poll here would redraw identical output forever.
 *
 * Title says "this server", deliberately, against "Display · this device"
 * and "Claude Agents · this machine" above it. Both of those really are
 * per-device: `useSettings` writes them to THIS browser's `localStorage`,
 * so opening the board on a phone shows different values than the laptop
 * that set them. `WatchdogConfig` cannot be that — the sweeper it configures
 * runs once, on the API host, with no browser open at all (design §5.1), so
 * `~/.backlog-manager/settings/watchdog.json` is the only copy that exists,
 * read fresh on every tick and every GET. A phone opening this same board
 * reads and writes the identical file the laptop just touched. Naming that
 * plainly in the group title — rather than reusing "this machine" and
 * letting a reader assume the same per-device meaning the neighbouring
 * group trained them to expect — is the whole point: silently reusing that
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
 * (design §5.3; `useWatchdog`'s own comment has the full reasoning). Rows
 * are not gated on `phase`: a knob is worth setting while nothing is
 * running, so the three selects and the checkbox render identically whether
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

/** The watchdog's own Settings group. Mounted directly after `AgentsGroup`
 *  in `SettingsView.tsx`. */
export function WatchdogGroup() {
  // `live: false` — see this file's header: with the State row gone,
  // nothing here changes on a clock, so the armed 5s poll would buy a
  // redraw nobody can see. The mount fetch and the focus refetch stay, and
  // they are what this group actually needs: they are how it learns the
  // config changed on another device.
  const { status, error, save } = useWatchdog({ live: false });

  // `useWatchdog` never throws — a failed GET lands in `error` and leaves
  // `status` at its initial `null` (see that hook's own comment for why a
  // stale-but-real status is kept on a LATER failure while `null` is kept
  // on the FIRST one). There is no `config` to bind three selects and a
  // checkbox to in that state, so this group renders a one-line notice and
  // nothing else — never a half-built row reading off a value that does
  // not exist, and never a thrown error from dereferencing `status.config`
  // on a `null` status.
  if (status === null) {
    return (
      <SettingsGroup title="Orchestrator watchdog · this server">
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Unavailable</span>
            <span className="set-hint">
              Could not reach the watchdog{error ? ` — ${error}` : ''}. This group will
              fill in once the API answers <code>GET /api/agents/watchdog</code> again.
            </span>
          </div>
        </div>
      </SettingsGroup>
    );
  }

  const { config } = status;

  return (
    <SettingsGroup title="Orchestrator watchdog · this server">
      {/* Not a `SettingsRow`: it has no control, and that is the point —
          this group opens with one paragraph of orientation and then four
          knobs. One row rather than two because both sentences answer the
          same question a person arriving here has ("where does this live,
          and where do I watch it work"). */}
      <div className="set-row">
        <div className="set-label">
          <span className="set-name">Live view</span>
          <span className="set-hint">
            These values live on the API host, in <code>~/.backlog-manager/settings/watchdog.json</code>
            {' '}— not this browser's storage. Every device that opens this board reads and
            writes that same one file, unlike the device-only groups above.
            {' '}The sweeper's state, the runs it is watching and its activity are on
            Runs › Watchdog.
          </span>
        </div>
      </div>

      <SettingsRow
        name="Enabled"
        hint="Your own switch (design's 'Disabled'), separate from the sweeper's own phase: watching, arming and reporting a crashed run all continue either way. Turning this off only withholds the resume spawn itself."
      >
        <input
          type="checkbox"
          aria-label="Enabled"
          checked={config.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
      </SettingsRow>

      <SettingsRow
        name="Check every"
        hint="How often the sweeper re-reads every project's run file for staleness while armed. Shorter notices a crash sooner; longer costs less on a server watching many projects."
      >
        <select
          aria-label="Check every"
          value={config.tickMs}
          onChange={(e) => void save({ tickMs: Number(e.target.value) })}
        >
          {ladderWithSelected(TICK_LADDER, config.tickMs).map((v) => (
            <option key={v} value={v}>{formatSpanCompact(v)}</option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow
        name="Leave a resumed run alone for"
        hint="How long a crashed run is left alone after any resume attempt or failure before the sweeper tries again. The floor is five minutes: a resume spawned into the same overload that caused the crash can take several minutes just to run its first command."
      >
        <select
          aria-label="Leave a resumed run alone for"
          value={config.graceMs}
          onChange={(e) => void save({ graceMs: Number(e.target.value) })}
        >
          {ladderWithSelected(GRACE_LADDER, config.graceMs).map((v) => (
            <option key={v} value={v}>{formatSpanCompact(v)}</option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow
        name="Give up after"
        hint="How many resume spawns one crashed run gets before the sweeper marks it exhausted and stops trying — past that point the crashed strip's own Resume button is the way forward, by hand."
      >
        <select
          aria-label="Give up after"
          value={config.maxAttempts}
          onChange={(e) => void save({ maxAttempts: Number(e.target.value) })}
        >
          {ladderWithSelected(ATTEMPT_LADDER, config.maxAttempts).map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </SettingsRow>
    </SettingsGroup>
  );
}
