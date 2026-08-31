import { useEffect, useState } from 'react';

import { ApiError, startOrchestrate } from '../../lib/agents';
import {
  EFFORTS, MODELS, actionLabel, clampMode, deriveAction, modesUpTo, type AgentAction
} from '../../../../shared/agent';
import { useSettings } from '../../hooks/useSettings';
import type { BacklogItem, PermissionMode } from '../../../../shared/types';

/**
 * OrchestrateSheet — the toolbar's "drain this project's whole groomed
 * queue" control, opened by BoardView's own Orchestrate button.
 *
 * Sibling of LaunchSheet, not a mode grafted onto it — Task 13's brief asks
 * for that decision to be made by reading LaunchSheet first and judging how
 * deep its coupling to a single `BacklogItem` runs. It runs all the way
 * through:
 *   - LaunchSheet's one effect fetches a PER-ITEM plan by `item.path`
 *     (`POST /api/agents/plan`) and hangs the whole render on it (loading /
 *     blocked / ready). There is no such endpoint for a whole project, and
 *     brief context point 6 is explicit that there must not be one — the
 *     orchestrator tool's own gate (orchestrate.mjs) is the only truth, and
 *     the run re-gates itself when it starts. So this component has no
 *     fetch effect at all; its "preview" is a pure derivation over props
 *     BoardView already had in hand (see `queue` below).
 *   - LaunchSheet's whole body is built around one editable `prompt`
 *     textarea for one item. Orchestrate has no prompt field, full stop —
 *     the server owns a constant one (`ORCHESTRATE_PROMPT`,
 *     agents.service.ts) and drops anything a caller sends, the same way
 *     dispatch's `action` is re-derived server-side rather than trusted.
 *   - LaunchSheet's dispatch body is keyed on `itemPath` + `action` and
 *     carries a `remoteControl` checkbox; `StartOrchestrateRequest`
 *     (lib/agents.ts) has neither — see agents.service.ts's own comment on
 *     why a board-started run deliberately never gets a remote-control
 *     channel.
 *   - LaunchSheet's success state replaces the form with a session link and
 *     stays open. This sheet closes immediately on success instead (see
 *     `start` below) — the run strip (Task 11) is the ongoing-progress
 *     surface for an orchestrate run, not this sheet, so there is no
 *     "launched" panel here to show at all.
 * All five state variables LaunchSheet holds (`plan`, `planError`, `prompt`,
 * `remoteControl`, `sessionId`) would therefore be either meaningless or
 * permanently unused in an "orchestrate mode" bolted onto it, and every
 * future edit to LaunchSheet would have to keep reasoning about a second,
 * unrelated flow sharing its state. A sibling avoids that;
 * what IS genuinely shared — `MODELS`/`EFFORTS`/`clampMode`/`modesUpTo`
 * (shared/agent.ts), `useSettings()`'s seeding, the `.sheet*` CSS vocabulary,
 * and the Escape-closes-on-`window` idiom every dialog in this app already
 * repeats independently (ItemDrawer, LaunchSheet, RunDrawer) — is imported
 * or restated in the same shape those already use, never copy-pasted out of
 * LaunchSheet's own body.
 */
export function OrchestrateSheet(
  { project, projectName, items, spawnMaxPermission, onClose, refresh }: {
    /** Registry path — the same string `StartOrchestrateRequest.project` and
     *  `BacklogItem.projectPath` both use. */
    project: string;
    /** Display name for the header; the registry's own name, not a path. */
    projectName: string;
    /** This project's items, unfiltered by the board's own search/status/sort
     *  — the preview below applies its own, narrower filter (see `queue`). */
    items: BacklogItem[];
    /** `AgentsStatus.spawnMaxPermission` — just the one field this sheet
     *  actually reads, taken directly rather than the whole status object so
     *  this component cannot be tempted to re-run `dispatchGate`'s own
     *  checks a second time. Those checks already happened once to decide
     *  whether the toolbar button that opens this sheet was even clickable,
     *  and the server re-runs the same check (`projectDispatchGate`,
     *  shared/agent.ts — one implementation, shared with `dispatchGate` and
     *  BoardView's own toolbar gate since Task 13's fix round 1) the instant
     *  Start is pressed — a second client-side copy here would be one more
     *  place for the two to drift apart, buying nothing the submit's own
     *  error path doesn't already cover. */
    spawnMaxPermission: PermissionMode | null;
    onClose: () => void;
    /** `useOrchestratorRuns()`'s own refresh — called after both a
     *  successful start (so the strip has the new run before the next
     *  5s poll would have found it on its own) and a 409 conflict (so the
     *  strip has the run that WON the race, per `start`'s own comment). */
    refresh: () => void;
  }
) {
  const { settings } = useSettings();
  const allowedModes = modesUpTo(spawnMaxPermission);
  // Same rule LaunchSheet's own defaultMode gets from the server
  // (`clampMode('auto', status.spawnMaxPermission)`, agents.service.ts's
  // `plan()`) — restated here as the same client-side call rather than a
  // second implementation, since `clampMode` is exactly the function that
  // makes it one rule instead of two: "auto, or the ceiling if auto is too
  // high" always lands on the same rung this way, whether it runs on the
  // server for a per-item plan or here for a whole project.
  const [mode, setMode] = useState<PermissionMode>(clampMode('auto', spawnMaxPermission));
  // Seeded from Settings and nowhere else — same invariant, same fields,
  // same reasoning as LaunchSheet's identical two lines (see that file's own
  // comment): a sticky per-launch pick is exactly the failure mode a stored
  // default exists to prevent, and reusing `Settings.dispatchDefaultModel` /
  // `dispatchDefaultEffort` rather than adding project-scoped defaults means
  // one Settings row governs every launch surface in the app, this one
  // included.
  const [model, setModel] = useState(settings.dispatchDefaultModel);
  const [effort, setEffort] = useState(settings.dispatchDefaultEffort);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same shape as LaunchSheet's and RunDrawer's own Escape effect —
  // independently duplicated a third time rather than factored out, matching
  // this codebase's existing choice (ItemDrawer and RunDrawer already each
  // carry their own copy of this exact four-line effect) over introducing a
  // shared hook this task was never asked for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * The queue preview — deliberately client-side and deliberately only an
   * approximation, per brief context point 6: there is no server endpoint
   * that runs the orchestrator's real gate against a whole project (adding
   * one would mean either shelling out to orchestrate.mjs on every sheet
   * open, or reimplementing its gate a second time in TypeScript — both
   * rejected), and the tool's own gate remains the only authority. That gate
   * (gateItem/gateTask/gateBug in orchestrate.mjs) inspects PROSE inside a
   * `## Plan`/`## Fix` section — a lone "TBD" earns `needs-answers` rather
   * than `ungroomed`, for instance — which is content this `BacklogItem`
   * shape never carries at all; the only signal the board already has is
   * exactly the one `deriveAction` (shared/agent.ts) already turns into
   * every card's own dispatch button — the same `groomed` flag DispatchButton
   * reads. So this preview reuses that identical derivation rather than
   * inventing a second, looser notion of "ready", and the note rendered
   * alongside it says outright that the real run may disagree once it
   * actually re-gates each item.
   */
  const queue = items
    .filter((item) => item.status === 'open')
    .map((item) => ({ item, action: deriveAction(item) }))
    .filter((row): row is { item: BacklogItem; action: AgentAction } => row.action !== null);

  const start = (): void => {
    setBusy(true);
    setError(null);
    startOrchestrate({
      project,
      // Same absent-not-empty convention LaunchSheet's own spread uses:
      // JSON.stringify drops an undefined key outright, which is what lets
      // the server's `pickFrom` and the dashboard's argv builder both read
      // "no flag" from a genuinely missing key rather than an empty string.
      ...(model === '' ? {} : { model }),
      ...(effort === '' ? {} : { effort }),
      permissionMode: mode
    })
      .then(() => {
        // No session link to show (see this file's own header comment) —
        // the run strip is what takes over from here, and `refresh()`
        // fetches it ahead of the next scheduled poll so it is already
        // there the instant this sheet closes rather than up to 5s later.
        refresh();
        onClose();
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        setBusy(false);
        setError(message);
        // The failure this sheet cannot offer a useful retry for: a 409
        // from this endpoint (agents.service.ts's `orchestrate()`) — most
        // commonly its activeRun lock ("a run is already in progress for
        // this project (<runId>)"), the case test case 7 names, but 409 is
        // also what a project-visibility/CLAUDE_BIN/remote-answer state
        // that raced the toolbar button's own render answers with. Every
        // one of those is a state a blind retry from THIS sheet, with THIS
        // stale form, is unlikely to fix on its own — and `refresh()` plus
        // the toolbar's own button (which re-derives its gate from live
        // state on the very next render) already report whichever of them
        // actually happened better than a static error string frozen at
        // click time. A 502 (the dashboard itself unreachable) is
        // deliberately NOT included here — see the "leaves the sheet open
        // and retryable for any other error" test — because trying again a
        // moment later genuinely might succeed once the dashboard answers.
        //
        // Detected by STATUS, not by matching the server's free-text
        // message (fix round 1: the substring check this replaced broke
        // silently the instant the server's wording changed, and no test
        // could catch that drift since the regression fixture's message was
        // independent of the real literal). `ApiError` (lib/agents.ts) is
        // what makes the status available to check at all — `unwrap` used
        // to discard it.
        if (e instanceof ApiError && e.status === 409) {
          refresh();
          onClose();
        }
      });
  };

  return (
    <>
      <div className="sheet-backdrop" data-testid="orchestrate-sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label={`orchestrate ${projectName}`}>
        <div className="sheet-head">
          <span className="sheet-kicker">orchestrate</span>
          <span className="sheet-title">{projectName}</span>
          <button className="drawer-close" onClick={onClose}>close</button>
        </div>

        <div className="sheet-body">
          <div className="sheet-note">
            preview — the run re-gates every item itself the moment it
            starts, so this list is not the final word on what actually runs.
          </div>

          {queue.length === 0 ? (
            <div className="drawer-empty">nothing groomed and open in this project</div>
          ) : (
            <div className="run-drawer-queue" data-testid="orchestrate-queue">
              {queue.map(({ item, action }) => (
                <div key={item.path} className="run-drawer-item">
                  <div className="run-drawer-item-head">
                    <span className="run-drawer-item-id">{item.id}</span>
                    <span className="run-drawer-item-title">{item.title}</span>
                    <span className={`orchestrate-preview-action ${action}`}>{actionLabel(item, action)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Same one-row grouping LaunchSheet's own `.sheet-row` uses for
              the identical three controls — "how should this run" is one
              decision there and stays one decision here. */}
          <div className="sheet-row">
            <label className="sheet-field">
              <span className="set-name">Permission mode</span>
              <select
                aria-label="Permission mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as PermissionMode)}
              >
                {allowedModes.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>

            <label className="sheet-field">
              <span className="set-name">Model</span>
              <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">default</option>
                {MODELS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>

            <label className="sheet-field">
              <span className="set-name">Effort</span>
              <select aria-label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">default</option>
                {EFFORTS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
          </div>

          {error !== null && <div className="sheet-error">{error}</div>}

          <div className="sheet-actions">
            <button className="drawer-close" onClick={onClose}>cancel</button>
            <button className="sheet-launch" onClick={start} disabled={busy}>
              {busy ? 'starting…' : 'start'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
