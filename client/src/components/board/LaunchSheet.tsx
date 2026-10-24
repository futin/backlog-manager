import { useEffect, useState } from 'react';

import {
  EXECUTE_FINISH_OPTIONS,
  dispatchAgent,
  fetchAgentPlan,
  fetchBranches,
  modelEffortFlags,
  sessionUrl
} from '../../lib/agents';
import { useAction } from '../../hooks/useAction';
import { useFetched } from '../../hooks/useFetched';
import { useRunOn } from '../../hooks/useRunOn';
import { useSettings } from '../../hooks/useSettings';
import { prRequiredText } from '../../lib/dashboards';
import { staleTakeover } from '../../lib/tracker';
import { Chip } from '../ui/Chip';
import { FormSheet } from '../ui/FormSheet';
import { RunOn } from '../ui/RunOn';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';
import { finishClause } from '../../../../shared/agent';
import type { BacklogItem, ExecuteFinish, PermissionMode } from '../../../../shared/types';

/**
 * LaunchSheet — the one extra tap between a card and a running Claude.
 *
 * It exists because dispatch is not a read: an `execute` launch edits code in
 * another repo with no human at a terminal. The sheet is where the prompt can
 * be read before it is sent, where the permission mode is chosen inside the
 * ceiling the host allows, and where "the dashboard cannot see this project"
 * surfaces before anything spawns rather than as a failed launch.
 *
 * The plan is re-fetched on open rather than passed down from the board's
 * status: the board's read may be minutes old, and the item may have been
 * groomed or archived in a terminal since.
 *
 * An `execute` launch also picks how the session finishes — In place or PR, and under PR the base branch — and a read-only line under the prompt shows the
 * closing clause those picks append. The plan's prompt carries no such clause: the server appends it at dispatch from the `finish`/`base` this sheet sends,
 * through the same `finishClause` this file previews with, so what is shown is what is sent. Its selects are the 36 px family, `.claude/DESIGN.md` §8.2/§8.6,
 * like every other select on this sheet.
 */
export function LaunchSheet({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  const { settings } = useSettings();
  const fetchedPlan = useFetched(() => fetchAgentPlan(item.path), [item.path]);
  const plan = fetchedPlan.value;
  const planError =
    fetchedPlan.status === 'failed' ? (fetchedPlan.error instanceof Error ? fetchedPlan.error.message : String(fetchedPlan.error)) : null;
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionMode>('plan');
  // '' is the "default" option: no flag, so the CLI's own default stands.
  //
  // Seeded from Settings, and from nowhere else. The sheet still does not
  // remember your LAST pick — a sticky 'max' from last week quietly spending on
  // a trivial groom is the failure mode a per-launch control exists to prevent,
  // and that remains rejected. A default you set once, in a row you can go and
  // read, is the opposite arrangement: it is visible, it is stable, and nothing
  // moves it behind your back. `clampSettings` has already dropped anything
  // outside MODELS/EFFORTS, so this can only ever seed a value the selects
  // below actually offer.
  //
  // Both live in `useRunOn` now: picking a remote machine narrows them to its lists and writes the narrowed value back, which is state the hook owns. They are
  // still seeded from Settings and from nowhere else.
  const runOn = useRunOn(item.projectPath);
  const { model, setModel, effort, setEffort } = runOn;
  const [remoteControl, setRemoteControl] = useState(true);
  // Execute's finish pick, seeded from Settings and from nowhere else, for the same reason as model/effort above. `clampSettings` has already dropped
  // anything outside EXECUTE_FINISHES, so the select can only be seeded with a value it offers. Only an `execute` plan draws or sends it.
  const [pickedFinish, setFinish] = useState<ExecuteFinish>(settings.executeDefaultFinish);
  // A remote machine takes PR only, so Finish is DERIVED from the pick rather than overwritten by it: the person's own choice stays in `pickedFinish` and
  // comes back untouched when they switch to home (Review Focus 5). Derived in render, the way the Orchestrate sheet derives its merge mode.
  const finish: ExecuteFinish = runOn.lock.prOnly ? 'pr' : pickedFinish;
  // Never stored, never seeded from a previous launch: a base is a fact about one repository's branches, so every open starts on `'main'`.
  const [base, setBase] = useState<string>('main');
  const { busy, error, run } = useAction();
  const [sessionId, setSessionId] = useState<string | null>(null);

  // `prompt` and `mode` are editable, so they are state seeded from the plan rather than read off it: once per fetched plan, keyed on the plan object
  // itself, so a re-render of the parent never overwrites what was typed. The stale-answer guard is `useFetched`'s.
  useEffect(() => {
    if (plan === null) return;
    setPrompt(plan.prompt);
    setMode(plan.defaultMode);
  }, [plan]);

  const isExecute = plan?.action === 'execute';
  /**
   * The Base select's options — `GET /api/agents/branches`, the Orchestrate sheet's base picker's read (`OrchestrateSheet.tsx`, task-44), keyed on the
   * project so it runs once per sheet open and never again as Finish flips. Skipped (`null`) for groom and capture, which draw no picker.
   *
   * **A failure here leaves the select holding `'main'` alone and never blocks a launch** — the reasoning is that sheet's, unchanged: the list only offers
   * alternatives to the default, so losing it costs the alternatives and leaves the default, which is exactly what a launch that asked for nothing else
   * wants. `'main'` is unioned in rather than assumed present, because a repository whose trunk is named something else has no `main` branch at all and the
   * select still has to offer the value the launch will send; the server proves the base against real branches and refuses a missing one, which is the
   * honest answer.
   */
  const fetchedBranches = useFetched(isExecute ? () => fetchBranches(item.projectPath) : null, [item.projectPath]);
  const fetchedList = fetchedBranches.status === 'ok' ? fetchedBranches.value! : [];
  const branches: string[] = fetchedList.includes('main') ? fetchedList : ['main', ...fetchedList];

  // Escape is `FormSheet`'s now (task-40), not this file's: one stack, one
  // window listener, topmost dialog only — see hooks/useDialogEscape.ts. The
  // shell binding it is what keeps bug-23's rule true of both sheets and the
  // item modal without any of the three remembering to.

  const launch = (): void => {
    if (plan === null) return;
    run(
      () =>
        dispatchAgent({
          itemPath: item.path,
          // The server's derivation, echoed back — and re-derived there before
          // anything spawns. Sending it makes a stale sheet fail loudly ("this
          // item's next step is groom") instead of quietly doing the wrong work.
          action: plan.action,
          prompt,
          permissionMode: mode,
          // Spread, not `model: model || undefined` — see `modelEffortFlags`.
          ...modelEffortFlags(model, effort),
          remoteControl,
          // Execute always names its finish, even untouched — the server appends the closing clause from it, so an absent key would read as in-place whatever
          // the sheet showed. `base` rides only under PR: a base picked and then abandoned must not reach an in-place launch, which the server refuses.
          // Groom and capture send neither key; the server 400s `finish` on any other action.
          ...(isExecute ? (finish === 'pr' ? { finish, base } : { finish }) : {}),
          // Only a remote pick names its machine; home sends no key at all, so a home-only board's request is byte-identical to what it was before the
          // picker existed (Review Focus 1).
          ...runOn.request
        }),
      { onSuccess: (r) => setSessionId(r.sessionId) }
    );
  };

  const blocked = plan?.blocked ?? planError;
  const form = sessionId === null && (blocked === null || blocked === undefined) && plan !== null;

  const takeover = staleTakeover(item, Date.now());

  return (
    <FormSheet
      label={`dispatch ${item.id}`}
      title={
        <>
          <span className="sheet-kicker">{plan === null ? 'dispatch' : plan.action}</span>
          <span className="sheet-title">
            {item.id} · {item.title}
          </span>
        </>
      }
      onClose={onClose}
      /* Only the form state has actions. A launched session's panel and a
         blocked one's message both end the sheet's job, and a footer holding
         nothing but a second `close` beside the shell's own would be two
         controls for one exit — and, in a suite, two buttons answering to the
         same accessible name. */
      footer={
        form ? (
          <>
            <Chip size={28} variant="flat" onClick={onClose}>
              cancel
            </Chip>
            <Chip size={28} variant="ink" disabled={busy || prompt.trim() === '' || runOn.blocked} onClick={launch}>
              {busy ? 'launching…' : runOn.remote ? `Start on ${runOn.label}` : 'launch'}
            </Chip>
          </>
        ) : null
      }
    >
      {sessionId !== null ? (
        /* The form is gone on purpose: the session exists, and a second
           Launch would start a second one on the same item. */
        <>
          <div className="sheet-ok">launched · {sessionId}</div>
          <a className="sheet-link" href={sessionUrl(settings.linkBase, sessionId)} target="_blank" rel="noreferrer">
            open in dashboard ↗
          </a>
          <div className="sheet-note">Its questions appear there — and on your phone, if the dashboard's hooks are installed.</div>
        </>
      ) : blocked !== null && blocked !== undefined ? (
        <div className="sheet-blocked">{blocked}</div>
      ) : plan === null ? (
        <div className="drawer-empty">loading…</div>
      ) : (
        <>
          {/* The picker leads the sheet (spec "The picker's look"): where this runs decides what Finish, Model and Effort below can be, so it is read first.
              `RunOn` draws nothing below two machines, which is a home-only board's whole sheet unchanged. */}
          {runOn.offers !== null && <RunOn offers={runOn.offers} value={runOn.machine} onChange={runOn.pick} />}
          {runOn.note !== null && <div className="sheet-note">{runOn.note}</div>}

          <label className="sheet-field">
            <span className="set-name">Project</span>
            <span className="sheet-static">{plan.project}</span>
          </label>

          {/* #227: dispatch is offered over a stale hand claim, and the spawned session's `start` retires that claim as its first act. Said here, before
              Launch, because the item modal's Release claim is the other way to clear it and the user should know this one will. `staleTakeover` is
              null for anything else — a live claim never reaches this form (`progressBlock` blocks it). */}
          {takeover !== null && <div className="sheet-note">{takeover}</div>}

          <label className="sheet-field">
            <span className="set-name">Prompt</span>
            <textarea aria-label="Prompt" className="sheet-prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>

          {/* The line the server will append to the prompt at launch — `finishClause`, the one function, so this cannot drift from what is sent. Read-only
              and outside the textarea on purpose: flipping Finish or Base updates only this line, never the plan and never what was typed. */}
          {isExecute && <div className="sheet-note">{finishClause('execute', finish, base)}</div>}

          {isExecute && (
            <div className="sheet-row">
              <label className="sheet-field">
                <span className="set-name">Finish</span>
                <Select<ExecuteFinish> label="Finish" value={finish} onChange={setFinish} options={EXECUTE_FINISH_OPTIONS} disabled={runOn.lock.prOnly} />
                {runOn.remote && <span className="sheet-note">{prRequiredText(runOn.label!)}</span>}
              </label>

              {finish === 'pr' && (
                <label className="sheet-field">
                  <span className="set-name">Base</span>
                  <Select label="Base" value={base} onChange={setBase} options={branches.map((b) => ({ value: b, label: b }))} />
                </label>
              )}
            </div>
          )}

          {/* One row, three controls: "how should this run" is a single
              decision, and the dashboard's own launch panel groups the same
              three the same way. Stacked, they pushed Launch below the fold
              on a phone — the device this whole feature is aimed at. */}
          <div className="sheet-row">
            <label className="sheet-field">
              <span className="set-name">Permission mode</span>
              {/* The 36 px family (§8.2/§8.6), one component per control, so
                  this sheet cannot drift from a Settings row about what a
                  select looks like. Only what the host's ceiling can actually
                  deliver: offering a mode the dashboard would clamp is a
                  promise this app cannot keep. */}
              <Select<PermissionMode>
                label="Permission mode"
                value={mode}
                onChange={setMode}
                options={plan.allowedModes.map((m) => ({ value: m, label: m }))}
              />
            </label>

            {/* Same two pickers the dashboard's own launch panel offers, with
                the same "default" first option, because this sheet is a second
                front-end onto that one spawn. Neither list is clamped against
                a host ceiling the way the modes above are — there is none —
                so an unknown name costs the flag, not the launch. */}
            <label className="sheet-field">
              <span className="set-name">Model</span>
              <Select label="Model" value={model} onChange={setModel} options={runOn.modelOptions} />
            </label>

            <label className="sheet-field">
              <span className="set-name">Effort</span>
              <Select label="Effort" value={effort} onChange={setEffort} options={runOn.effortOptions} />
            </label>
          </div>

          {/* A Switch, not a checkbox: §8's standing rule is that a raised
              control marks a STATE, and this is one that persists for the
              length of the session it launches. */}
          <div className="sheet-check">
            <Switch checked={remoteControl} onChange={setRemoteControl} label="remote control" />
            <span>remote control — the Claude phone app can see and drive it</span>
          </div>

          {error !== null && <div className="sheet-error">{error}</div>}
        </>
      )}
    </FormSheet>
  );
}
