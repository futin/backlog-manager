import { useEffect, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { useNow } from '../../hooks/useNow';
import { useSettings } from '../../hooks/useSettings';
import { jiraSettingOf, resolveJiraAction, runChipState, skillCommand } from '../../lib/jira';
import { pollAge } from '../../lib/tracker';
import { JIRA_BUILTIN_LABELS } from '../../../../shared/types';
import type { JiraAction, JiraIssue } from '../../../../shared/types';
import { Glyph, type GlyphName } from '../ui/Glyphs';
import { Popover } from '../ui/Popover';
import { SplitChip } from '../ui/SplitChip';

/**
 * JiraRunMenu — the split `Run | ▾`, the control that starts a session on a Jira issue (Jira phase 5, spec §7; restyle spec §4.1; picked mock
 * `RunButton.dc.html`, column A; DESIGN.md §8.9.1 on the card, §8.9.2 in the modal). One component for both homes — the card's marker row and the modal's
 * controls row — because two copies would be two places to decide what "no repository" or "a session is running" looks like.
 *
 * **Two buttons, two jobs.** The left half runs the default action straight away: `onPick(resolveJiraAction(settings.jiraDefaultAction, data.skills))`, which
 * opens the launch sheet on that action and never the menu. The chevron half opens the `Run menu` for a person who wants a different action. The stored
 * setting goes through `resolveJiraAction` — the helper Settings' own select uses, so a deleted skill's id reads as `execute` here exactly as it does there.
 *
 * **It decides nothing itself.** `runChipState` (`lib/jira.ts`) is the one answer, read from the shell's status through `useJiraContext()` and the sessions
 * payload through `useJiraSessionsContext()` (the one-run gate is a live `run` link, not any live session — that function's header says what each source adds):
 * - `no-repo` — the primitive's `dashed` look and both halves disabled, titled `no repository mapped for <PROJECT> — Jira › Setup › Repositories`: there is
 *   nowhere to run, and the title says where to fix that.
 * - `live` — both halves disabled, titled `a session is running on <KEY>`, the left half reading `Running · <age>` behind a steady green dot. The age is the
 *   status entry's `startedAt` when there is one, else the newest open `run` link's — the same two sources `runChipState` unions. The strip beside it carries
 *   the session and Detail's Stop.
 * - `ready` — the menu: `Built in` (the two built-ins), then `Skills on this machine · N` (omitted at zero), then a footer saying every choice opens the launch
 *   sheet first. A pick calls `onPick(action)`, closes the menu and hands focus to the chevron; the sheet itself belongs to the page (`JiraView`), because it
 *   has to mount ABOVE an open modal. The preferred row stays where it is and is only marked — a menu that reorders itself moves under the pointer.
 *
 * **Never hidden for agents' sake.** With agents off the control still draws and the menu still opens: the launch sheet's own `Copy prompt` needs no
 * dashboard, so hiding it would take away the one half of the feature that works without one. The sheet is what hides `Start` (spec §7).
 *
 * **On a card, the control stops the card.** The wrapper swallows the click and Enter/Space — the card's own key handler `preventDefault()`s both, which would
 * cancel a button's activation, and the click would open the issue modal under the menu. Only those two keys: stopping every key broke Escape for
 * `DispatchButton`'s identical wrapper (the dialog stack's one `window` listener never saw it), and Escape here is what closes the panel. `SplitChip` stops
 * them on each half too; the wrapper also covers the panel, which renders inside it.
 *
 * `jira-run-open` is a page class, not a look: the card clips its content (`overflow: hidden`, for the radius), and an absolute panel under the control would
 * be clipped with it, so the stylesheet lets the card overflow while this class is on a descendant.
 *
 * **In the modal the panel still hangs from the controls row**, now 300 px wide in every home: the stylesheet makes `.jira-modal-controls` the positioning
 * parent, the panel's right edge the row's. The row sits at the foot of a column that scrolls under 700 px, so the panel is scrolled into view
 * (`block: 'nearest'`, which moves the column only as far as it must) on open.
 */
const MENU_WIDTH = 300;

interface MenuRow {
  id: string;
  action: JiraAction;
  label: string;
  sub: string;
  glyph: GlyphName;
}

export function JiraRunMenu({ issue, onPick, home = 'card' }: { issue: JiraIssue; onPick: (action: JiraAction) => void; home?: 'card' | 'modal' }) {
  const { data } = useJiraContext();
  const { data: sessions } = useJiraSessionsContext();
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const state = data === null ? null : runChipState(issue, data, sessions);
  // The age clock ticks (once a minute) only while a Running reading is on screen.
  const now = useNow(state === 'live');
  // The modal's panel, brought into the facts column's view once it is drawn (header). Optional-called: jsdom implements no `scrollIntoView`.
  useEffect(() => {
    if (open && home === 'modal') wrapper.current?.querySelector('[role="dialog"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, home]);
  if (data === null || state === null) return null;

  const title =
    state === 'no-repo'
      ? `no repository mapped for ${issue.project.key} — Jira › Setup › Repositories`
      : state === 'live'
        ? `a session is running on ${issue.key}`
        : undefined;
  const defaultAction = resolveJiraAction(settings.jiraDefaultAction, data.skills);
  const preferred = jiraSettingOf(defaultAction);
  const builtIns: MenuRow[] = [
    { id: 'execute', action: 'execute', label: JIRA_BUILTIN_LABELS.execute, sub: 'Work the ticket end to end', glyph: 'play' },
    { id: 'context', action: 'context', label: JIRA_BUILTIN_LABELS.context, sub: 'A session, you drive', glyph: 'document' }
  ];
  const skills: MenuRow[] = data.skills.map((k) => ({ id: k.id, action: { skill: k.id }, label: k.name, sub: skillCommand(k.prompt) ?? '', glyph: 'sparkle' }));
  const pick = (action: JiraAction): void => {
    setOpen(false);
    onPick(action);
    // The panel unmounts under the pick; focus goes where the next Tab should start rather than to `body`.
    more.current?.focus();
  };
  const row = (r: MenuRow) => {
    const isDefault = r.id === preferred;
    return (
      <button key={r.id} type="button" className={isDefault ? 'jira-run-opt jira-run-opt-default' : 'jira-run-opt'} title={r.label} onClick={() => pick(r.action)}>
        <span className="jira-run-tile" aria-hidden="true">
          <Glyph name={r.glyph} />
        </span>
        <span className="jira-run-text">
          <span className="jira-run-label">{r.label}</span>
          {r.sub !== '' && (
            <span className="jira-run-sub" aria-hidden="true">
              {r.sub}
            </span>
          )}
        </span>
        {isDefault && (
          <span className="jira-run-mark" aria-hidden="true">
            <Glyph name="tick" size={14} />
            default
          </span>
        )}
      </button>
    );
  };

  // The newest open `run` link is the fallback source of the age, the same predicate `runChipState` gates on.
  const liveSince =
    data.live[issue.key]?.startedAt ??
    sessions?.links
      .filter((l) => l.key === issue.key && l.how === 'run' && l.endedAt === null)
      .map((l) => l.startedAt)
      .sort()
      .pop() ??
    null;
  const age = state === 'live' ? pollAge(liveSince, now) : null;

  return (
    <div
      ref={wrapper}
      className={open ? 'jira-run jira-run-open' : 'jira-run'}
      data-state={state}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      <SplitChip
        label={`Run ${issue.key}`}
        labelMore={`Run options for ${issue.key}`}
        size={home === 'modal' ? 32 : 28}
        icon={state === 'live' ? <span className="jira-run-dot" /> : <Glyph name="play" />}
        open={open}
        disabled={state !== 'ready'}
        dashed={state === 'no-repo'}
        title={title}
        moreRef={more}
        onMain={() => onPick(defaultAction)}
        onMore={() => setOpen((o) => !o)}
      >
        {state === 'live' ? (age === null ? 'Running' : `Running · ${age}`) : 'Run'}
      </SplitChip>
      {open && state === 'ready' && (
        <Popover label="Run menu" width={MENU_WIDTH} anchor={more} onClose={() => setOpen(false)}>
          <div className="jira-run-head">Built in</div>
          {builtIns.map(row)}
          {skills.length > 0 && <div className="jira-run-head">Skills on this machine · {skills.length}</div>}
          {skills.map(row)}
          <hr className="jira-run-rule" />
          <div className="jira-run-note">Every choice opens the launch sheet first</div>
        </Popover>
      )}
    </div>
  );
}
