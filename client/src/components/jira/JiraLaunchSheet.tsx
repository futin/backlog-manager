import { useEffect, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { errorMessage, useAction } from '../../hooks/useAction';
import { useAgents } from '../../hooks/useAgents';
import { useFetched } from '../../hooks/useFetched';
import { useSettings } from '../../hooks/useSettings';
import { EFFORT_OPTIONS, MODEL_OPTIONS, modelEffortFlags, sessionUrl } from '../../lib/agents';
import {
  branchDispatchFields,
  defaultModeFor,
  displayPath,
  dispatchJira,
  fetchJiraDetail,
  fetchJiraPrompt,
  jiraWritesStand,
  transitionOptions
} from '../../lib/jira';
import { clampMode, modesUpTo, projectDispatchGate } from '../../../../shared/agent';
import { JIRA_BUILTIN_LABELS, jiraActionParam } from '../../../../shared/types';
import type { JiraAction, JiraDispatchResult, JiraIssue, PermissionMode } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { FormSheet } from '../ui/FormSheet';
import { JiraBranchSection, useBranchState } from './JiraBranchSection';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';

/**
 * JiraLaunchSheet — the one extra tap between a ticket and a running Claude (Jira phase 5, spec §7; DESIGN.md §8.7 Sheet, §8.9 — the board's `LaunchSheet` is
 * its sibling and this mirrors its shape). Dispatch is not a read: an `execute` launch edits code in another repo with no human at a terminal, so the sheet is
 * where the prompt is read before it is sent, where the permission mode is chosen inside the ceiling the host allows, and where "the dashboard cannot see this
 * repository" surfaces before anything spawns. It is composed from `FormSheet`, so Escape and the scrim are the shell's and nothing here binds a key (Escape
 * has one owner).
 *
 * **The preview is the server's prompt, not this file's.** `GET /api/jira/prompt` composes what Start sends (and what Copy prompt copies) — one
 * composition behind three readers — so the sheet never builds a prompt, and a refusal (`unknown skill s_…` for a skill deleted since the menu was drawn,
 * `prompt too long`) is drawn where the prompt would be, with Start disabled: a sentence the server refused is not one to launch. It is keyed on the
 * action, the repository and the branch choice through `useFetched`, so a superseded answer never lands over the one the reader is looking at.
 *
 * **The branch choice is the Branch section's** (`JiraBranchSection`, spec §5.3): this sheet holds its state, because the preview, Copy prompt and Start all
 * carry it — the preview on its query, Start as the five flat fields. Until the section has seeded from the chosen repository's refs nothing is asked: a
 * preview of the previous repository's branch is a sentence nobody chose. A choice the section refuses asks for no preview either, so Copy prompt has nothing
 * to copy and Start carries the refusal as its reason — the server would refuse the same choice with the same sentence.
 *
 * **Two reads, one sheet.** The ticket's transitions and assignee come from one `GET /api/jira/issue/:key` on open — the board card carries neither — and
 * the agents status (`useAgents`) is asked on open too, never inherited from the board, because the board's copy may be minutes old.
 *
 * **Start is gated by one function.** `projectDispatchGate(status, repo)` is the board's own gate: `hidden` (agents off, dashboard unreachable) draws no
 * Start at all — Copy prompt is the whole point of the sheet then — and `disabled` draws it with the gate's reason as its title. No Start is drawn before
 * the status lands, rather than a dead one that is enabled a moment later. Copy prompt never waits on the gate: it needs the preview and a clipboard.
 *
 * **Permissions are derived, not stored.** The mode the select shows is the reader's pick if there is one, else `defaultModeFor(action)`, clamped to the
 * ceiling at render (`clampMode`). Changing the action drops the pick, so `context` re-seeds `plan` and `execute` `acceptEdits` — and a ceiling that has
 * not landed yet is the floor (`modesUpTo(null)`), never the top. Model and effort seed from Settings and nowhere else (LaunchSheet's rule: a sticky `max`
 * from last week is the failure a per-launch control exists to prevent).
 *
 * **Two writes ride along, both opt-in and both off.** `Assign to me` (disabled with a reason when the ticket is already the reader's, or `me` is not
 * known) and `Move to` (`leave as is` is `transitionId: null`). Neither is applied by this file: the server does it BEFORE the spawn — assign, then
 * transition, then the session — so a write that landed stands if the spawn then fails, and the refusal says so (`jiraWritesStand`).
 */
export function JiraLaunchSheet({
  issue,
  initialAction,
  onClose,
  onStarted,
  onWrote
}: {
  issue: JiraIssue;
  initialAction: JiraAction;
  onClose: () => void;
  onStarted: () => void;
  onWrote: () => void;
}) {
  const { settings } = useSettings();
  const { data } = useJiraContext();
  const { status: agents } = useAgents();
  const { busy, error, run } = useAction();

  const skills = data?.skills ?? [];
  const me = data?.me ?? null;
  const paths = data?.repos[issue.project.key] ?? [];

  const [action, setAction] = useState<JiraAction>(initialAction);
  // '' is "not chosen": several mapped paths wait for a pick, and the preview waits with them rather than guessing a repository. A single path is
  // derived, not seeded — the mapping can arrive after mount (the status is the shell's, and may still be loading when the sheet opens), and a one-shot
  // `useState` seed would leave a statically shown path unselected with no control to fix it.
  const [pickedRepo, setRepo] = useState('');
  const repo = pickedRepo === '' && paths.length === 1 ? paths[0] : pickedRepo;
  const [pickedMode, setPickedMode] = useState<PermissionMode | null>(null);
  const [model, setModel] = useState(settings.dispatchDefaultModel);
  const [effort, setEffort] = useState(settings.dispatchDefaultEffort);
  const [assign, setAssign] = useState(false);
  const [transitionId, setTransitionId] = useState('');
  const [remoteControl, setRemoteControl] = useState(true);
  const [started, setStarted] = useState<JiraDispatchResult | null>(null);

  const actionKey = jiraActionParam(action);
  const branch = useBranchState(action, repo, issue.key, issue.summary, data?.repoDefaults[repo]);
  const branchSent = branch.ready && branch.refusal === null;
  const preview = useFetched(branchSent ? () => fetchJiraPrompt(issue.key, action, repo, branch.choice) : null, [
    issue.key,
    actionKey,
    repo,
    JSON.stringify(branch.choice)
  ]);
  const detail = useFetched(() => fetchJiraDetail(issue.key), [issue.key]);

  const promptText = preview.status === 'ok' ? preview.value : null;
  const promptRefusal = preview.status === 'failed' ? (preview.error instanceof Error ? preview.error.message : String(preview.error)) : null;

  const ceiling = agents?.spawnMaxPermission ?? null;
  const modes = modesUpTo(ceiling);
  const mode = clampMode(pickedMode ?? defaultModeFor(action), ceiling);

  // The detail's assignee is the fresher copy; the card's is what stands until it lands (or for good, if that read fails).
  const assignee = detail.value?.assignee ?? issue.assignee;
  const assignBlock =
    me === null ? 'your Jira identity is not known yet' : assignee !== null && assignee.accountId === me.accountId ? 'already assigned to you' : null;
  const transitions = detail.value?.transitions ?? [];
  const detailFailure = detail.status === 'failed' ? (detail.error instanceof Error ? detail.error.message : String(detail.error)) : null;

  // Asked with `repo` even when it is `''`: `projectDispatchGate` reads the environment block before it looks at the path, so `hidden` (agents off, dashboard
  // unreachable) holds whatever has been picked, and Start is never drawn and then withdrawn the moment a repository is chosen.
  const gate = agents === null ? null : projectDispatchGate(agents, repo);
  const startDrawn = gate !== null && gate.control !== 'hidden';
  // The first reason that applies, in the order the reader can act on them: the repository, the dashboard's view of it, the branch, the prompt itself.
  const startBlock =
    repo === ''
      ? 'choose a repository'
      : gate?.control === 'disabled'
        ? gate.reason
        : !branch.ready
          ? 'the branches have not loaded'
          : branch.refusal !== null
            ? branch.refusal.text
            : promptText === null
              ? (promptRefusal ?? 'the prompt has not loaded')
              : null;
  // What the Switch DISPLAYS is what Start sends: a ticket that turns out to be the reader's already (the detail lands after a toggle) reads Off.
  const assignNow = assign && assignBlock === null;

  // Copy prompt: the button is absent without a clipboard API (the preview stays selectable text), reads `Copied` for 2 s, and a refused write says so.
  const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    []
  );
  const copy = (): void => {
    if (promptText === null) return;
    navigator.clipboard.writeText(promptText).then(
      () => {
        setCopyFailed(false);
        setCopied(true);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => setCopyFailed(true)
    );
  };

  const start = (): void => {
    if (startBlock !== null) return;
    run(
      () =>
        dispatchJira({
          key: issue.key,
          repo,
          action,
          assign: assignNow,
          // `null` is "leave as is" — the server's own spelling, not an empty string it would have to refuse.
          transitionId: transitionId === '' ? null : transitionId,
          ...branchDispatchFields(branch.choice),
          ...modelEffortFlags(model, effort),
          permissionMode: mode,
          remoteControl
        }),
      {
        onSuccess: (result) => {
          setStarted(result);
          onStarted();
        },
        // Returns nothing, so the refusal still renders. A write that landed before the spawn failed has moved the ticket: the board is told (the same reload and
        // nudge a landed Start triggers) and `Move to` goes back to `leave as is`, because the fresh read no longer offers that transition and a second Start
        // sending it would be a 400 `transition not offered` the reader could only clear by hand. A refusal before any write carries no such sentence.
        onError: (err) => {
          if (!jiraWritesStand(errorMessage(err))) return;
          setTransitionId('');
          onWrote();
        }
      }
    );
  };

  const actionOptions = [
    { value: 'execute', label: JIRA_BUILTIN_LABELS.execute },
    { value: 'context', label: JIRA_BUILTIN_LABELS.context },
    ...skills.map((k) => ({ value: `skill:${k.id}`, label: k.name }))
  ];
  // A skill the menu no longer lists (deleted since the action was chosen) still has to be the select's value, or React would show the first option
  // while the preview — and Start — carry another action. It is listed by its id, and the preview's refusal says what happened.
  if (typeof action !== 'string' && !skills.some((k) => k.id === action.skill)) actionOptions.push({ value: actionKey, label: `skill ${action.skill}` });

  const footer = started !== null ? null : (
    <>
      {canCopy && (
        <Chip size={28} variant="flat" disabled={promptText === null} onClick={copy}>
          {copied ? 'Copied' : 'Copy prompt'}
        </Chip>
      )}
      {startDrawn && (
        <Chip size={28} variant="ink" disabled={busy || startBlock !== null} title={startBlock ?? undefined} onClick={start}>
          {busy ? 'starting…' : 'Start'}
        </Chip>
      )}
    </>
  );

  return (
    <FormSheet
      label={`run ${issue.key}`}
      title={
        <>
          <span className="sheet-kicker">run</span>
          <span className="sheet-title">
            {issue.key} · {issue.summary}
          </span>
        </>
      }
      onClose={onClose}
      /* The launched state ends the sheet's job, and a footer holding only a second exit beside the shell's own close would be two controls for one exit. */
      footer={footer}
    >
      {started !== null ? (
        /* The form is gone on purpose: the session exists, and a second Start would be a second one on the same ticket (the server refuses it, 409 — but
           the sheet never offers it). */
        <>
          <div className="sheet-ok">started · {started.sessionId}</div>
          <a className="sheet-link" href={sessionUrl(settings.linkBase, started.sessionId)} target="_blank" rel="noreferrer">
            open in dashboard ↗
          </a>
          <div className="sheet-note">Its questions appear there — and on your phone, if the dashboard's hooks are installed.</div>
        </>
      ) : (
        <>
          <label className="sheet-field">
            <span className="set-name">Action</span>
            <Select
              label="Action"
              value={actionKey}
              onChange={(v) => {
                setAction(v === 'execute' || v === 'context' ? v : { skill: v.slice('skill:'.length) });
                setPickedMode(null);
              }}
              options={actionOptions}
            />
          </label>

          <div className="sheet-field">
            <span className="set-name">Repository</span>
            {paths.length === 1 ? (
              <span className="sheet-static" title={paths[0]}>
                {displayPath(paths[0], data?.home ?? null)}
              </span>
            ) : (
              <Select
                label="Repository"
                value={repo}
                onChange={setRepo}
                options={[{ value: '', label: 'choose…' }, ...paths.map((p) => ({ value: p, label: displayPath(p, data?.home ?? null) }))]}
              />
            )}
          </div>

          <JiraBranchSection branch={branch} action={action} repo={repo} home={data?.home ?? null} />

          <label className="sheet-field">
            <span className="set-name">Prompt</span>
            {promptText !== null ? (
              <textarea aria-label="Prompt" className="sheet-prompt" rows={8} readOnly value={promptText} />
            ) : promptRefusal !== null ? (
              <div className="sheet-blocked">{promptRefusal}</div>
            ) : (
              <div className="sheet-note">
                {repo === '' ? 'choose a repository to see the prompt' : branch.refusal !== null ? 'fix the branch above to see the prompt' : 'loading…'}
              </div>
            )}
          </label>

          <div className="sheet-row">
            <div className="sheet-field">
              <span className="set-name">Assign to me</span>
              <Switch
                checked={assignNow}
                onChange={setAssign}
                label="Assign to me"
                disabled={assignBlock !== null}
                title={assignBlock ?? undefined}
              />
            </div>
            <label className="sheet-field">
              <span className="set-name">Move to</span>
              <Select
                label="Move to"
                value={transitionId}
                onChange={setTransitionId}
                disabled={detail.status !== 'ok'}
                title={detailFailure ?? undefined}
                options={[{ value: '', label: 'leave as is' }, ...transitionOptions(transitions)]}
              />
            </label>
          </div>

          <div className="sheet-row">
            <label className="sheet-field">
              <span className="set-name">Permissions</span>
              {/* Only what the host's ceiling can deliver: offering a mode the dashboard would clamp is a promise this app cannot keep. */}
              <Select<PermissionMode> label="Permissions" value={mode} onChange={setPickedMode} options={modes.map((m) => ({ value: m, label: m }))} />
            </label>
            <label className="sheet-field">
              <span className="set-name">Model</span>
              <Select label="Model" value={model} onChange={setModel} options={MODEL_OPTIONS} />
            </label>
            <label className="sheet-field">
              <span className="set-name">Effort</span>
              <Select label="Effort" value={effort} onChange={setEffort} options={EFFORT_OPTIONS} />
            </label>
          </div>

          {/* A Switch, not a checkbox: §8's standing rule is that a raised control marks a STATE, and this one persists for the session it launches. */}
          <div className="sheet-check">
            <Switch checked={remoteControl} onChange={setRemoteControl} label="Remote control" />
            <span>remote control — the Claude phone app can see and drive it</span>
          </div>

          {copyFailed && <div className="sheet-note">The clipboard refused — select the prompt above and copy it by hand.</div>}
          {error !== null && (
            <div className="sheet-error" role="alert">
              {error}
            </div>
          )}
        </>
      )}
    </FormSheet>
  );
}
