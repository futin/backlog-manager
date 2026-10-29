import { useTicks } from '../../hooks/useTicks';
import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Select } from '../ui/Select';
import { TICK_CAP_LIMITS, TICK_HALT_LIMITS } from '../../../../shared/types';

/**
 * The tick breaker's Settings card (tick-breaker spec, "Settings"; drawn to `.claude/DESIGN.md` §8.6 — a `SettingsGroup` of three `SettingsRow`s, each a
 * 36 px `Select`, the same composition `WatchdogGroup` makes of its three ladders). Three knobs: how many failed ticks in a row halt a project, and the two
 * caps a tick job applies when its prompt carries no `--max-plans` / `--max-prs` flag (#378) — how many plans may wait in `plan-review` before a tick stops
 * grooming, and how many `execute/*` PRs may be open before it stops executing. A job's flag still wins over either cap: a number written into one
 * schedule's prompt is a fact about that schedule, and this card sets the default for every job on this machine that does not say.
 *
 * It sits on the SHARED page, under the watchdog, for the reason the watchdog does: `tick.json` is a file on the API host, read by the server and by
 * `tick.mjs` alike, so a phone and a laptop that open this board are editing the same three numbers. The scope subtitle says `this machine` — the word the
 * Shared page's pill and its other host cards use — rather than the watchdog's `this server`: the setting binds every tick job that runs on this machine,
 * whichever process is asking.
 *
 * Selects of 1–10, not number fields, for `WatchdogGroup`'s reason: the server clamps `haltAfter` to `TICK_HALT_LIMITS` and each cap to `TICK_CAP_LIMITS`
 * quietly and a POST outside them is a 400, so a free-text field could be typed past the bound and silently snap. The options are built from the same shared
 * limits the server clamps against,
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
 *   - `source: "unreadable"`: `tick.json` exists and cannot be parsed. The server shows all three numbers at their defaults for display only and refuses
 *     every write (409, file untouched), so all three Selects are DISABLED together and the first row's hint names the file and says what to do — the one fix is by hand, and offering a control that
 *     can only fail would be the silent no-op this card exists to avoid. The Ticks page's own figures are unaffected: they read `state.json`, not this file;
 *   - a refused save (`saveError`): one `role="alert"` row under the controls, saying the pick was not saved and that the values shown are the ones still
 *     on the server. Each pick posts only its own key, so a refusal can leave no Select off the server's value. `data` is intact in that state, which is why it is a field of its own beside the failed-GET `error` (`useTicks`' comment has the argument).
 */
function ladder(limits: { min: number; max: number }): { value: string; label: string }[] {
  return Array.from({ length: limits.max - limits.min + 1 }, (_, i) => {
    const n = String(limits.min + i);
    return { value: n, label: n };
  });
}
const HALT_OPTIONS = ladder(TICK_HALT_LIMITS);
const PLANS_OPTIONS = ladder(TICK_CAP_LIMITS.maxPlans);
const PRS_OPTIONS = ladder(TICK_CAP_LIMITS.maxPrs);

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
        <Select
          label="Halt after"
          value={String(config.haltAfter)}
          options={HALT_OPTIONS}
          disabled={unreadable}
          onChange={(v) => void save({ haltAfter: Number(v) })}
        />
        <span className="set-hint">failures in a row</span>
      </SettingsRow>
      <SettingsRow
        name="Plans awaiting review"
        hint={
          <>
            A tick stops grooming once this many plans wait for review. A job’s <code>--max-plans</code> overrides it.
          </>
        }
      >
        <Select
          label="Plans awaiting review"
          value={String(config.maxPlans)}
          options={PLANS_OPTIONS}
          disabled={unreadable}
          onChange={(v) => void save({ maxPlans: Number(v) })}
        />
      </SettingsRow>
      <SettingsRow
        name="Open execute PRs"
        hint={
          <>
            A tick stops executing once this many <code>execute/*</code> PRs are open. A job’s <code>--max-prs</code> overrides it.
          </>
        }
      >
        <Select
          label="Open execute PRs"
          value={String(config.maxPrs)}
          options={PRS_OPTIONS}
          disabled={unreadable}
          onChange={(v) => void save({ maxPrs: Number(v) })}
        />
      </SettingsRow>
      {saveError !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">Not saved — {saveError}. The values shown are the ones still on the server.</span>
        </div>
      )}
    </SettingsGroup>
  );
}
