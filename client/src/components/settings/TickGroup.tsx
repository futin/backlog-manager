import { useTicks } from '../../hooks/useTicks';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Select } from '../ui/Select';
import { TICK_HALT_LIMITS } from '../../../../shared/types';

/**
 * The tick breaker's Settings card (tick-breaker spec, "Settings"; drawn to `.claude/DESIGN.md` §8.6 — a `SettingsGroup` of one `SettingsRow` and its 36 px
 * `Select`, the same composition `WatchdogGroup` makes of its three ladders). One knob: how many failed ticks in a row halt a project.
 *
 * It sits on the SHARED page, under the watchdog, for the reason the watchdog does: `tick.json` is a file on the API host, read by the server and by
 * `tick.mjs` alike, so a phone and a laptop that open this board are editing the same one number. The scope subtitle says `this machine` — the word the
 * Shared page's pill and its other host cards use — rather than the watchdog's `this server`: the setting binds every tick job that runs on this machine,
 * whichever process is asking.
 *
 * A Select of 1–10, not a number field, for `WatchdogGroup`'s reason: the server clamps `haltAfter` to `TICK_HALT_LIMITS` quietly and a POST outside it is a
 * 400, so a free-text field could be typed past the bound and silently snap. The options are built from the same shared triple the server clamps against,
 * which leaves no value on offer that the server would have to correct. There is no "off-ladder current value" splice as in the watchdog's ladders, because
 * the server reads an out-of-range FILE value back already clamped into this very range — the payload cannot carry a number the list lacks.
 *
 * `useTicks({ live: false })`: nothing in this card changes on a clock, so the 15 s poll the Runs › Ticks page arms would redraw identical output forever.
 * The mount fetch and the focus refetch remain, and they are how the card learns the number changed on another device. A save redraws from the POST's own
 * answer (the hook's contract), never from a follow-up GET, so what the Select shows after a pick is what the server holds — if it answered 6 to a pick of 5,
 * the card says 6.
 *
 * Three states beside the ordinary one, each with its own wording rather than a shared "something went wrong":
 *   - no answer yet (the first GET failed): a one-line notice and NO control — there is no value to bind a Select to, and a Select defaulting to 3 would be
 *     a setting that was never read presented as one that was;
 *   - `source: "unreadable"`: `tick.json` exists and cannot be parsed. The server shows `haltAfter` at its default for display only and refuses every write
 *     (409, file untouched), so the Select is DISABLED and the hint names the file and says what to do — the one fix is by hand, and offering a control that
 *     can only fail would be the silent no-op this card exists to avoid. The Ticks page's own figures are unaffected: they read `state.json`, not this file;
 *   - a refused save (`saveError`): one `role="alert"` row under the control, saying the pick was not saved and that the value shown is the one still on the
 *     server. `data` is intact in that state, which is why it is a field of its own beside the failed-GET `error` (`useTicks`' comment has the argument).
 */
const HALT_OPTIONS = Array.from({ length: TICK_HALT_LIMITS.max - TICK_HALT_LIMITS.min + 1 }, (_, i) => {
  const n = String(TICK_HALT_LIMITS.min + i);
  return { value: n, label: n };
});

export function TickGroup() {
  const { data, error, saveError, save } = useTicks({ live: false });

  if (data === null) {
    return (
      <SettingsGroup title="Backlog tick" scope="this machine">
        <div className="set-row set-row-stacked">
          <div className="set-label">
            <span className="set-name">Unavailable</span>
            <span className="set-hint">
              Could not reach the tick settings{error ? ` — ${error}` : ''}. This group will fill in once the API answers <code>GET /api/ticks</code> again.
            </span>
          </div>
        </div>
      </SettingsGroup>
    );
  }

  const { config } = data;
  const unreadable = config.source === 'unreadable';

  return (
    <SettingsGroup title="Backlog tick" scope="this machine">
      <SettingsRow
        name="Halt after"
        hint={
          unreadable
            ? `${config.error ?? 'tick.json is unreadable'} — fix or remove the file by hand.`
            : 'A halted project stops ticking until reset on Runs › Ticks.'
        }
      >
        <Select label="Halt after" value={String(config.haltAfter)} options={HALT_OPTIONS} disabled={unreadable} onChange={(v) => void save(Number(v))} />
        <span className="set-hint">failures in a row</span>
      </SettingsRow>
      {saveError !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">Not saved — {saveError}. The value shown is the one still on the server.</span>
        </div>
      )}
    </SettingsGroup>
  );
}
