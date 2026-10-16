import { useEffect, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraPage } from '../../hooks/useJiraPage';
import type { JiraPage } from '../../lib/jira-page';
import type { JiraIssue } from '../../../../shared/types';
import { JiraBoardView } from './JiraBoardView';
import { JiraIssueModal } from './JiraIssueModal';
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
 */
export default function JiraView({ onOpenJiraPage }: { onOpenJiraPage: (p: JiraPage) => void }) {
  const { data, error } = useJiraContext();
  const [page] = useJiraPage();
  const [openIssue, setOpenIssue] = useState<JiraIssue | null>(null);
  // The slot is JiraView's, and JiraView does not unmount on a page switch, so leaving the Board must clear it by hand — otherwise returning to Board would
  // redraw the modal for an issue the reader closed the page on.
  useEffect(() => setOpenIssue(null), [page]);

  if (data === null) return <div className="board-empty">{error ? 'Jira unavailable' : 'loading…'}</div>;
  if (!data.configured) return <div className="board-empty">Jira is not configured</div>;
  return page === 'setup' ? (
    <JiraSetupView onOpenJiraPage={onOpenJiraPage} />
  ) : (
    <>
      <JiraBoardView onOpenJiraPage={onOpenJiraPage} onOpenIssue={setOpenIssue} />
      {openIssue !== null && <JiraIssueModal issue={openIssue} onClose={() => setOpenIssue(null)} />}
    </>
  );
}
