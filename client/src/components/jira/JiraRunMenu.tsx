import { Fragment, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useSettings } from '../../hooks/useSettings';
import { jiraSettingOf, resolveJiraAction, runChipState, skillCommand } from '../../lib/jira';
import { JIRA_BUILTIN_LABELS } from '../../../../shared/types';
import type { JiraAction, JiraIssue } from '../../../../shared/types';
import { Chevron } from '../ui/Chevron';
import { Chip } from '../ui/Chip';
import { Popover } from '../ui/Popover';

interface MenuRow {
  id: string;
  action: JiraAction;
  label: string;
  hint: string;
  /** A skill row: the rule above the first one separates it from the built-ins. */
  skill: boolean;
}

/**
 * JiraRunMenu — `Run ▾`, the chip that starts a session on a Jira issue (Jira phase 5, spec §7; DESIGN.md §8.9.1 on the card, §8.9.2 in the modal; the
 * picked mock is `RunMenu.html`, where the spec differs the spec wins). One component for both homes — the card's marker row and the modal's controls row —
 * because two copies would be two places to decide what "no repository" or "a session is running" looks like.
 *
 * **It decides nothing itself.** `runChipState` (`lib/jira.ts`) is the one answer, read from the shell's status through `useJiraContext()`:
 * - `no-repo` — a DASHED chip (the wrapper's `data-state`, so the stylesheet needs no class of this family on a `Chip`, which takes none) titled
 *   `no repository mapped for <PROJECT> — Jira › Setup › Repositories`. It opens nothing: there is nowhere to run, and the title says where to fix that.
 * - `live` — disabled, titled `a session is running on <KEY>`. The strip beside it carries the session and the modal's Stop.
 * - `ready` — a `Popover` with the two built-ins, a rule, this machine's skills by name, a rule, and the note `opens the launch sheet`. A pick calls
 *   `onPick(action)` and closes the panel; the sheet itself belongs to the page (`JiraView`), because it has to mount ABOVE an open modal.
 *
 * **The menu is where `Jira default action` is read.** Both homes of `Run ▾` hand the sheet the row that was clicked, so the sheet never seeds from the setting
 * (final review I1: a setting nothing read). The stored value goes through `resolveJiraAction` — the helper Settings' own select uses, so a deleted skill's id
 * reads as `execute` here exactly as it does there — and THAT row is listed first with the hint `default`, in place of `built-in` or a skill's slash command.
 * The other rows keep their order (built-ins, rule, skills) minus the promoted one, and the rule between built-ins and skills is drawn only while there are
 * skills left below it. A pick still opens the sheet on exactly the row's own action.
 *
 * **Never hidden for agents' sake.** With agents off the chip still draws and the menu still opens: the launch sheet's own `Copy prompt` needs no
 * dashboard, so hiding the chip would take away the one half of the feature that works without one. The sheet is what hides `Start` (spec §7).
 *
 * **On a card, the chip stops the card.** The wrapper swallows the click and Enter/Space — the card's own key handler `preventDefault()`s both, which would
 * cancel the button's activation, and the click would open the issue modal under the menu. Only those two keys: stopping every key broke Escape for
 * `DispatchButton`'s identical wrapper (the dialog stack's one `window` listener never saw it), and Escape here is what closes the panel.
 *
 * `jira-run-open` is a page class, not a look: the card clips its content (`overflow: hidden`, for the radius), and an absolute panel under the chip would be
 * clipped with it, so the stylesheet lets the card overflow while this class is on a descendant.
 */
export function JiraRunMenu({ issue, onPick }: { issue: JiraIssue; onPick: (action: JiraAction) => void }) {
  const { data } = useJiraContext();
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  if (data === null) return null;

  const state = runChipState(issue, data);
  const title =
    state === 'no-repo'
      ? `no repository mapped for ${issue.project.key} — Jira › Setup › Repositories`
      : state === 'live'
        ? `a session is running on ${issue.key}`
        : undefined;
  // One row per action, in the menu's own order — the built-ins, then the skills — with the resolved default pulled to the front and its hint replaced.
  const preferred = jiraSettingOf(resolveJiraAction(settings.jiraDefaultAction, data.skills));
  const all: MenuRow[] = [
    ...(['execute', 'context'] as const).map((id) => ({
      id,
      action: id as JiraAction,
      label: JIRA_BUILTIN_LABELS[id],
      hint: 'built-in',
      skill: false
    })),
    ...data.skills.map((k) => ({ id: k.id, action: { skill: k.id } as JiraAction, label: k.name, hint: skillCommand(k.prompt) ?? '', skill: true }))
  ];
  const rows: MenuRow[] = [
    ...all.filter((r) => r.id === preferred).map((r) => ({ ...r, hint: 'default' })),
    ...all.filter((r) => r.id !== preferred)
  ];
  const pick = (action: JiraAction): void => {
    setOpen(false);
    onPick(action);
  };

  return (
    <div
      className={open ? 'jira-run jira-run-open' : 'jira-run'}
      data-state={state}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      <Chip
        ref={chip}
        size={28}
        aria-label={`Run ${issue.key}`}
        aria-haspopup={state === 'ready' ? 'dialog' : undefined}
        aria-expanded={state === 'ready' ? open : undefined}
        disabled={state === 'live'}
        title={title}
        onClick={() => {
          if (state === 'ready') setOpen((o) => !o);
        }}
      >
        Run <Chevron dir={open ? 'up' : 'down'} />
      </Chip>
      {open && state === 'ready' && (
        <Popover label="Run menu" width={320} anchor={chip} onClose={() => setOpen(false)}>
          {/* The right-hand hint is decorative and `aria-hidden`: a button's name is the words a person picks by; `built-in` or `default` is a category. */}
          {rows.map((row, i) => (
            <Fragment key={row.id}>
              {/* The rule sits between the last built-in and the first skill, wherever the promoted row left them. */}
              {i > 0 && row.skill && !rows[i - 1].skill && <hr className="jira-run-rule" />}
              <button type="button" className="jira-run-opt" onClick={() => pick(row.action)}>
                <span>{row.label}</span>
                <span className="jira-run-hint" aria-hidden="true">
                  {row.hint}
                </span>
              </button>
            </Fragment>
          ))}
          <hr className="jira-run-rule" />
          <div className="jira-run-note">opens the launch sheet</div>
        </Popover>
      )}
    </div>
  );
}
