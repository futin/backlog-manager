import { useEffect, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraPage } from '../../hooks/useJiraPage';
import type { JiraChildrenIndex } from '../../lib/jira';
import type { JiraPage } from '../../lib/jira-page';
import type { JiraAction, JiraIssue } from '../../../../shared/types';
import { JiraBoardView } from './JiraBoardView';
import { JiraIssueModal } from './JiraIssueModal';
import { JiraLaunchSheet } from './JiraLaunchSheet';
import { JiraSetupView } from './JiraSetupView';

/**
 * JiraView — the Jira section (Jira phase 2, spec §6.1; DESIGN.md §8.9, and §8.0 for the tree that switches its pages). Lazy in `App`, like every section,
 * so a machine that never configures Jira never fetches this chunk.
 *
 * It decides one thing: which of the section's two pages is drawn, read from `useJiraPage` — the module store the rail's `Board`/`Setup` tree writes. It
 * draws NO control that switches them, at any width (the Runs/Settings rule, CLAUDE.md "Settings is two pages…"): the tree is the switch, and the two
 * in-page links that also land on a page (`Open board` on Setup, the empty board's chip to Setup) are `onOpenJiraPage`, the rail's own navigation threaded
 * down from `App`, handed to the pages as given.
 *
 * Before a page can draw, the status has to have said `configured: true`, and until then this is where the section stands — `App` holds a stored `jira`
 * section through every answer that is not `configured: false` (spec §6.1's hold-and-fall), so these states are what that hold looks like:
 *
 * - **No answer yet** (`data` null, `loading`) — `loading…`, the Board section's own loading line in its own `board-empty` shape. Not the shell's Suspense
 *   spinner: the chunk has arrived, it is the status that has not.
 * - **Every read so far failed** (`data` null, `error`) — `Jira unavailable`, in the Board section's `board unavailable` shape. A failure says nothing about
 *   whether the site is configured, so it must not move the reader (Review Focus 5) and must not claim `No boards yet` either; `useJira` retries at its floor,
 *   and the first answer either draws the page or moves the shell.
 * - **`configured: false`** — drawn for the one render between that answer and `App`'s fall effect moving the shell to Board. A line rather than nothing, so
 *   even that frame says what is true.
 *
 * Once a status has said `configured: true`, a later failed read keeps it (`useJira` keeps the last answer through a failure), so a page that is up stays
 * up through a blip; what a page says about a stale or failing status is that page's business.
 *
 * **The open issue is held HERE, not in the Board page.** The Board's card click lands in this slot (`onOpenIssue`), and the issue modal is drawn
 * from it. Held one level above the page so that the slot outlives a re-render of the board under it — a poll that reorders the columns, a board switch —
 * and is read by exactly one modal mount. The modal is drawn only beside the Board page: Setup has no card to open one from, and the slot is cleared whenever `page`
 * changes, so a stale issue never survives a trip to Setup and back (JiraView itself does not unmount on a page switch).
 *
 * The slot holds the issue AND the board's fold index as it stood at the click (`childrenOf`, grouped-board spec §6), which the modal's Children tree hangs
 * grandchildren from. One setter serves both the board's card click and the modal's tree-row click, so a row swaps the one modal's issue and carries the
 * same snapshot forward — never a second modal.
 *
 * **The write counter is held here too** (Jira phase 3, plan ruling R7). The modal's landed write — `Assign to me`, `Move to…` — calls `onWrote`,
 * which bumps `nudge`; the Board page hands it to `useJiraBoard`, whose list re-reads at once on the change, `off` boards included. The two never reach
 * into each other: this component is the one place that holds both the modal and the page, so it is the one place a number can pass between them. The
 * counter is not cleared on a page switch — it is a count of events, not a state, and only its change means anything.
 *
 * **The launch sheet is held HERE too, ONE for the whole section** (Jira phase 5, spec §7; the task-10 brief put it on the board page and this is the
 * deliberate deviation). `Run ▾` is drawn in two homes, a card and the modal, and both call `onRun(issue, action)`; the sheet they open has to mount AFTER an
 * open modal so that it is the topmost entry of the one dialog stack — Escape then closes the sheet alone and the modal stays, with no second key listener.
 * The modal is this component's child, not the board page's, so this is the one place that can order them. `onStarted` is a landed Start: it reloads the shell's
 * status (the strip is `live`, and the status poll alone runs on the boards' clock — minutes away) and bumps `nudge`, because a Start may have assigned and
 * moved the ticket. Like the open issue, the slot is cleared whenever `page` changes.
 */
export default function JiraView({ onOpenJiraPage }: { onOpenJiraPage: (p: JiraPage) => void }) {
  const { data, error, reload } = useJiraContext();
  const [page] = useJiraPage();
  const [openIssue, setOpenIssue] = useState<{ issue: JiraIssue; childrenOf: JiraChildrenIndex | null } | null>(null);
  const openOne = (issue: JiraIssue, childrenOf: JiraChildrenIndex | null): void => setOpenIssue({ issue, childrenOf });
  // The slot is JiraView's, and JiraView does not unmount on a page switch, so leaving the Board must clear it by hand — otherwise returning to Board would
  // redraw the modal for an issue the reader closed the page on.
  useEffect(() => setOpenIssue(null), [page]);
  const [launch, setLaunch] = useState<{ issue: JiraIssue; action: JiraAction } | null>(null);
  useEffect(() => setLaunch(null), [page]);
  const [nudge, setNudge] = useState(0);
  const run = (issue: JiraIssue, action: JiraAction): void => setLaunch({ issue, action });

  if (data === null) return <div className="board-empty">{error ? 'Jira unavailable' : 'loading…'}</div>;
  if (!data.configured) return <div className="board-empty">Jira is not configured</div>;
  return page === 'setup' ? (
    <JiraSetupView onOpenJiraPage={onOpenJiraPage} />
  ) : (
    <>
      <JiraBoardView onOpenJiraPage={onOpenJiraPage} onOpenIssue={openOne} onRun={run} nudge={nudge} />
      {openIssue !== null && (
        <JiraIssueModal
          issue={openIssue.issue}
          childrenOf={openIssue.childrenOf}
          onOpenIssue={openOne}
          onWrote={() => setNudge((n) => n + 1)}
          onRun={run}
          onClose={() => setOpenIssue(null)}
        />
      )}
      {/* After the modal, so it is the stack's topmost entry — see the header. Keyed by issue so a second launch never inherits the first one's form. */}
      {launch !== null && (
        <JiraLaunchSheet
          key={launch.issue.key}
          issue={launch.issue}
          initialAction={launch.action}
          onClose={() => setLaunch(null)}
          onStarted={() => {
            reload();
            setNudge((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
