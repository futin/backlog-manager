import { useEffect, useState } from 'react';

import { ApiError, fetchMergeCheck, startOrchestrate, type MergeCheckResult } from '../../lib/agents';
import {
  EFFORTS, MODELS, actionLabel, clampMode, deriveAction, modesUpTo, type AgentAction
} from '../../../../shared/agent';
import { useSettings } from '../../hooks/useSettings';
import { MERGE_MODES, RUN_IN_PROGRESS_CODE } from '../../../../shared/types';
import type { BacklogItem, MergeMode, PermissionMode } from '../../../../shared/types';

/**
 * The merge-mode picker's own words (design §2.2): each names the OUTCOME a
 * successful run ends in, never the flag a caller would type — "why would I
 * pick 'branch'" is a worse question for this control to answer than "why
 * would I pick 'leave branches for me'". A `Record<MergeMode, string>`
 * rather than an ordered pair of literal strings, for the same reason
 * `isMergeMode` is a guard rather than an inline comparison chain
 * (shared/agent.ts): the compiler refuses to build this file the day
 * `MergeMode` gains a third member and nobody has decided what this control
 * calls it.
 */
const MERGE_MODE_LABELS: Record<MergeMode, string> = {
  merge: 'Merge to main',
  branch: 'Leave branches for me'
};

/**
 * The exact JSON the setup hint (§6) tells a reader to paste. One `allow`
 * entry — `Bash(git merge:*)`, the family-level rule `merge-check.util.ts`'s
 * own comment names as the plainest of the three shapes it accepts — never
 * the broader `Bash(git:*)` (grants every git subcommand, not just the one
 * this run needs) or the narrower `--no-ff` variant (buys nothing extra: the
 * family rule already covers the literal invocation SKILL.md issues).
 * `JSON.stringify(..., null, 2)` rather than a hand-typed multi-line
 * template so this can never drift from actually-valid JSON.
 */
const MERGE_ALLOW_SNIPPET = JSON.stringify({ permissions: { allow: ['Bash(git merge:*)'] } }, null, 2);

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
 *     the run re-gates itself when it starts. So this component's "preview"
 *     is a pure derivation over props BoardView already had in hand (see
 *     `queue` below), never a fetch. Task 8 later added the one genuine
 *     exception — a `GET /api/agents/merge-check` effect behind the
 *     merge-mode picker — and it is deliberately built so a failure can
 *     never gate anything: unlike a blocked LaunchSheet, this sheet stays
 *     fully usable whether or not that request ever comes back.
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
  /**
   * The merge-mode picker (Task 8; design §2.2) — seeded from Settings and
   * overridable for this launch only, the identical rule `model`/`effort`
   * above already follow. `'merge'` runs exactly as every launch before this
   * feature existed; `'branch'` tells the run to stop at a reviewed
   * `backlog/<id>` branch instead of merging it into `main` (`MergeMode`'s
   * own doc comment, shared/types.ts, has the full behavioural difference).
   * See `start` below for why the request always carries this value, even
   * when it is the untouched default.
   */
  const [mergeMode, setMergeMode] = useState<MergeMode>(settings.orchestrateDefaultMergeMode);
  /**
   * The setup hint's own data (§6) — whether this project's Claude Code
   * settings already grant `git merge`. `null` covers three different
   * states at once: not asked yet, still in flight, and "the request failed
   * outright" — all three render no hint at all (brief case 7), because a
   * hint is not worth a loading spinner or an error banner bolted onto a
   * control that launches a run just fine without it. See the effect below
   * for exactly when this is fetched.
   */
  const [mergeCoverage, setMergeCoverage] = useState<MergeCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which previewed rows are selected, by item id, or `null` for "the whole
   * queue" — the state this sheet opens in and the state it must be able to
   * return to.
   *
   * `null` rather than "a set holding every id" is the entire mechanism
   * behind the strict-subset rule below, and it is worth being explicit
   * about why a plain full set is wrong. A full set and `null` describe the
   * same selection but not the same INSTRUCTION: an explicit list freezes
   * the run to the queue as it stood when this sheet opened, so an item
   * groomed and committed while someone was reading the list would be
   * silently dropped from a run they believe is draining everything. Keeping
   * "no restriction" as its own value means the untouched sheet — and a
   * sheet toggled all the way off and all the way back on — sends the
   * request it sent before this control existed, byte for byte.
   *
   * Keyed by id, not by path: ids are what the request carries and what the
   * orchestrator's own `--ids` flag takes, so there is no second identity to
   * keep in step. (The rows themselves still key on `item.path`, which is
   * what React needs and what stays unique across sections.)
   */
  const [selected, setSelected] = useState<Set<string> | null>(null);

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
   * The setup hint's data source (§6) — fetched only while `mergeMode` is
   * actually `'merge'` (brief case 6: branch mode fetches nothing at all).
   * Branch mode never touches `main`, so this project's `git merge`
   * coverage is none of its business — asking anyway would spend a request
   * nobody reads the answer to, and risk a hint flashing into view for the
   * one instant between picking 'merge' and picking 'branch' right back.
   *
   * `alive` is `LaunchSheet`'s own `fetchAgentPlan` effect's guard (see that
   * file), restated here rather than shared — this file's own header
   * comment already explains why a sibling component repeats small idioms
   * like this instead of factoring them out. It matters for two reasons at
   * once: a slow response landing after the mode has flipped back to
   * `branch`, or after this sheet has closed, must not call
   * `setMergeCoverage` on a render that no longer wants the answer — which
   * would otherwise be either a stale hint or React's own "cannot update
   * state on an unmounted component" warning.
   *
   * The `.catch` is deliberately silent (brief case 7): this hint exists to
   * make a merge more likely to succeed, not to gate one, and a network
   * hiccup here must cost the user nothing more than a hint that never shows
   * up. `error`/`busy` stay `start`'s own state below, untouched either way
   * — a failed merge-check must never block or blemish a launch that
   * otherwise works.
   */
  useEffect(() => {
    if (mergeMode !== 'merge') {
      setMergeCoverage(null);
      return;
    }
    let alive = true;
    fetchMergeCheck(project)
      .then((result) => {
        if (alive) setMergeCoverage(result);
      })
      .catch(() => {
        if (alive) setMergeCoverage(null);
      });
    return () => {
      alive = false;
    };
  }, [mergeMode, project]);

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
   *
   * The section filter is NOT part of that approximation, and is why
   * `deriveAction` alone is not the whole predicate here. `deriveAction`
   * answers "what would this card's dispatch button do", and for an idea or a
   * refactor the honest answer is `'groom'` (shared/agent.ts) — but an
   * orchestrate run's queue is bugs and tasks and nothing else, by
   * construction: `GATE_SECTIONS = { bugs, tasks }` in orchestrate.mjs, which
   * mirrors backlog-execute's own "never touches ideas, refactors or
   * out-of-scope". So a preview built on `deriveAction` alone listed rows the
   * run can never look at — a project with a dozen ideas showed a dozen of
   * them — and the sheet's disclaimer does not cover that: it promises the
   * run may re-gate an item to a different VERDICT, not that whole sections
   * are out of scope. This is the last screen before a multi-hour unattended
   * operation, so it lists what the run will actually consider and nothing
   * else. An ungroomed bug or task stays in the list, labelled `groom`,
   * because the run really will look at it and really will report it as
   * ungroomed — that is information, not noise.
   */
  const queue = items
    .filter((item) => item.status === 'open' && (item.section === 'bugs' || item.section === 'tasks'))
    .map((item) => ({ item, action: deriveAction(item) }))
    .filter((row): row is { item: BacklogItem; action: AgentAction } => row.action !== null);

  /**
   * The selection, resolved against the queue as it stands right now.
   *
   * Everything below is derived rather than stored, which is what keeps
   * `selected` from drifting out of step with `queue`: an id that has left
   * the queue since it was ticked simply stops appearing here, so a stale
   * id can never reach the request.
   *
   * `narrowed` is the strict-subset test the whole request shape turns on,
   * and it is deliberately a comparison against the queue rather than a
   * "has the user touched anything" flag. Select-none followed by
   * select-all lands back on the full queue, and must therefore land back
   * on the full-queue REQUEST — a touched-flag would send an explicit list
   * there and quietly reintroduce the snapshot problem `selected`'s own
   * comment describes.
   */
  const queueIds = queue.map(({ item }) => item.id);
  const isSelected = (id: string): boolean => selected === null || selected.has(id);
  const selectedIds = queueIds.filter(isSelected);
  const narrowed = selectedIds.length < queueIds.length;
  /** Nothing ticked, with rows to tick — refused below. An EMPTY QUEUE is
   *  not this state: there is nothing to narrow, so the sheet keeps its
   *  pre-selector behaviour and starts a plain whole-queue run. Refusing
   *  there would be the board overruling the orchestrator's own gate on the
   *  strength of a preview that says outright it is not authoritative. */
  const emptySelection = queueIds.length > 0 && selectedIds.length === 0;

  const toggle = (id: string): void => {
    // `prev ?? queueIds` is where "the whole queue" becomes an explicit set:
    // the first tick has to start from everything, because that is what the
    // sheet has been showing since it opened.
    setSelected((prev) => {
      const next = new Set(prev ?? queueIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
      // Unlike model/effort above and ids below, this is NEVER wrapped in a
      // conditional spread — see `mergeMode`'s own state comment. It is the
      // sheet's explicit answer to "what should this run do", sent even
      // when it equals the untouched Settings default, because inferring it
      // server-side from an absent field would put that one decision in two
      // places (design §2.2).
      mergeMode,
      // The same absent-not-empty convention, for the field it matters most
      // on: `ids` rides along ONLY for a strict subset. A full list would be
      // a different instruction from no list at all (see `selected` and
      // `narrowed` above), and an EMPTY list is refused outright by the
      // server — `parseIdsArg` in orchestrate.mjs keeps "no flag" and "an
      // explicit empty selection" apart precisely so that `--ids ''` cannot
      // silently mean "everything", and `emptySelection` above is what stops
      // this sheet from ever posing that question.
      ...(narrowed ? { ids: selectedIds } : {}),
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
        // The ONE failure this sheet cannot offer a useful retry for: the
        // activeRun lock — a DIFFERENT run already exists for this project
        // (agents.service.ts's `orchestrate()`, "a run is already in
        // progress for this project (<runId>)"). Retrying from this sheet
        // cannot fix that; `refresh()` pulls the winning run in and
        // `onClose()` hands the screen to the strip that already owns it.
        //
        // Fix round 1 tried `e.status === 409` alone — an improvement over
        // matching the message's own prose, but still wrong, because this
        // endpoint answers 409 for THREE OTHER reasons too (project just
        // lost visibility, no CLAUDE_BIN, remote answers off — all folded
        // into `gate.control === 'hidden'`/`'disabled'` server-side, plus
        // the dirName race). Status alone cannot tell those apart from the
        // lock, and reporting "already running" for a capability or
        // visibility problem is not a milder version of the bug the
        // message-substring check had — it is a confidently WRONG answer,
        // worse than the brittle one it replaced. Fix round 2: the server
        // now sends a `code` field (RUN_IN_PROGRESS_CODE, shared/types.ts)
        // on the lock 409 ONLY, so this checks status AND that exact code
        // — every other 409 (uncoded) falls through to the generic path
        // below and shows the server's own, accurate error text instead.
        if (e instanceof ApiError && e.status === 409 && e.code === RUN_IN_PROGRESS_CODE) {
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
            {/* The disclaimer above promises the run may re-gate an item to
                a different VERDICT. It says nothing about the run skipping
                most of the list, so a narrowed selection needs its own
                sentence: this is the last screen before a multi-hour
                unattended operation, and "I thought it was draining
                everything" is not something anyone finds out cheaply. */}
            {narrowed && selectedIds.length > 0 && (
              <> only the {selectedIds.length} selected {selectedIds.length === 1 ? 'item' : 'items'} will run.</>
            )}
          </div>

          {queue.length === 0 ? (
            <div className="drawer-empty">nothing groomed and open in this project</div>
          ) : (
            <>
              {/* Buttons rather than a tri-state header checkbox: an
                  indeterminate checkbox has no accessible state a screen
                  reader reads usefully without extra aria, and "all" and
                  "none" are two different intentions here rather than two
                  positions of one control — `selected === null` (no
                  restriction) and a full explicit set are not the same
                  request, and only "select all" can get back to the first. */}
              <div className="orchestrate-select-actions">
                <span className="sheet-note">{selectedIds.length} of {queueIds.length} selected</span>
                <button
                  type="button"
                  className="drawer-close"
                  onClick={() => setSelected(null)}
                  disabled={!narrowed}
                >
                  select all
                </button>
                <button
                  type="button"
                  className="drawer-close"
                  onClick={() => setSelected(new Set())}
                  disabled={selectedIds.length === 0}
                >
                  select none
                </button>
              </div>

              <div className="run-drawer-queue" data-testid="orchestrate-queue">
                {queue.map(({ item, action }) => (
                  <div key={item.path} className="run-drawer-item">
                    <div className="run-drawer-item-head">
                      {/* Labelled by id, which is both unique in this list
                          and the exact string the request carries — so the
                          accessible name names the thing being selected
                          rather than describing it. Never disabled for an
                          ungroomed row: the run really will queue it, gate
                          it and report it, and this screen has no authority
                          to decide otherwise (see `queue` above). */}
                      <input
                        type="checkbox"
                        className="orchestrate-select"
                        aria-label={`select ${item.id}`}
                        checked={isSelected(item.id)}
                        onChange={() => toggle(item.id)}
                      />
                      <span className="run-drawer-item-id">{item.id}</span>
                      <span className="run-drawer-item-title">{item.title}</span>
                      <span className={`orchestrate-preview-action ${action}`}>{actionLabel(item, action)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
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

            <label className="sheet-field">
              <span className="set-name">Merge mode</span>
              <select
                aria-label="Merge mode"
                value={mergeMode}
                onChange={(e) => setMergeMode(e.target.value as MergeMode)}
              >
                {MERGE_MODES.map((m) => (
                  <option key={m} value={m}>{MERGE_MODE_LABELS[m]}</option>
                ))}
              </select>
            </label>
          </div>

          {/* The setup hint (§6) — shown only under `merge` mode, and only
              once the check has actually come back uncovered (brief cases
              4/5/6/7 above). States the missing path as FACT and the effect
              as a LIKELIHOOD, the same two-part shape `dispatchGate`'s own
              reason string uses (shared/agent.ts) and for the same reason:
              no reader of this sentence is closer to the auto-mode
              classifier than a settings file is, so it can say what is
              missing but never promise what adding it will do. It never
              offers to write the file — text and JSON to paste by hand,
              nothing clickable — an explicit non-goal of the design. */}
          {mergeMode === 'merge' && mergeCoverage !== null && !mergeCoverage.covered && (
            <div className="sheet-note orchestrate-merge-hint">
              <p>
                <code>{project}/.claude/settings.local.json</code> has no{' '}
                <code>git merge</code> allow rule. The run may still merge
                without one, but not reliably — the auto-mode classifier's
                verdict on that exact command varies between runs. Add this
                to the file, creating it if it does not exist yet (or merge
                the one entry into an existing <code>permissions.allow</code>{' '}
                list rather than replacing it):
              </p>
              <pre className="orchestrate-merge-hint-json">{MERGE_ALLOW_SNIPPET}</pre>
            </div>
          )}

          {error !== null && <div className="sheet-error">{error}</div>}

          {/* Refused here as well as server-side, and the wording is why:
              the server's 400 is correct but arrives after a round trip and
              cannot say what this can — unticking everything means "run
              nothing", which is never what anyone wants and is emphatically
              not the same as "run everything". */}
          {emptySelection && (
            <div className="sheet-note">pick at least one item, or select all to drain the queue.</div>
          )}

          <div className="sheet-actions">
            <button className="drawer-close" onClick={onClose}>cancel</button>
            <button className="sheet-launch" onClick={start} disabled={busy || emptySelection}>
              {busy ? 'starting…' : 'start'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
