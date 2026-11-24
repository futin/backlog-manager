import { useEffect, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraMentionsContext, useMentionIndex } from '../../hooks/JiraMentionsContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { setJiraPage, useJiraPage } from '../../hooks/useJiraPage';
import { setJiraTicketKey, useJiraTicketKey, useJiraTicketOrigin } from '../../hooks/useJiraTicketKey';
import type { JiraChildrenIndex } from '../../lib/jira';
import type { JiraPage, TicketOrigin } from '../../lib/jira-page';
import type { GitlabMr, JiraAction, JiraIssue, JiraMention, JiraMentionIssue, ReviewHalf } from '../../../../shared/types';

/**
 * What a review launch adds to the sheet's state: the half, the MR (its source branch is the sheet's locked branch) and the candidate repos — or, for a review
 * SKILL picked from an MR's `Review menu` (Jira review skills spec §4, §6), the skill's id and the whole `GitlabMr` the row was drawn from, whose five values
 * the sheet sends and the server re-checks against its cache.
 */
type ReviewLaunch =
  | { half: ReviewHalf; mr: { project: string; iid: number; sourceBranch: string }; repos: string[] }
  | { skill: string; mr: GitlabMr; repos: string[] };
import { JiraBoardView } from './JiraBoardView';
import { JiraDetail } from './JiraDetail';
import { JiraLaunchSheet } from './JiraLaunchSheet';
import { JiraMentionsView } from './JiraMentionsView';
import { MentionModalHost } from './MentionModalHost';
import { MentionOpenContext } from './MentionOpenContext';
import { JiraSessionsView } from './JiraSessionsView';
import { JiraSetupView } from './JiraSetupView';
import { JiraTicketPage } from './JiraTicketPage';

/**
 * JiraView — the Jira section (Jira phase 2, spec §6.1; DESIGN.md §8.9, and §8.0 for the tree that switches its pages). Lazy in `App`, like every section,
 * so a machine that never configures Jira never fetches this chunk.
 *
 * It decides one thing: which of the section's four pages (Board, Sessions, Mentions, Setup) is drawn, read from `useJiraPage` — the module store the rail's
 * tree writes. It draws NO control that switches them, at any width (the Runs/Settings rule, CLAUDE.md "Settings is three pages…"): the tree is the switch, and
 * the in-page links that also land on a page (`Open board` and Sessions' `Open Setup`, the empty board's chip to Setup) are `onOpenJiraPage`, the rail's own
 * navigation threaded down from `App`, handed to the pages as given. The Mentions page's `Open ticket page` chips and the mention modal's are the ticket link
 * instead: `openPage(key)` from wherever the dialog was opened (origin `mentions` from the page, `board` or `sessions` from a mark), or just a close when the
 * ticket page already shows that key.
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
 * **The open issue is held HERE, not in the Board page.** The Board's card click lands in this slot (`onOpenIssue`), and the Detail dialog is drawn
 * from it. Held one level above the page so that the slot outlives a re-render of the board under it — a poll that reorders the columns, a board switch —
 * and is read by exactly one modal mount. The modal is drawn beside the Board and Sessions pages: Setup has no card or row to open one from, and the slot is cleared whenever `page`
 * changes, so a stale issue never survives a trip to Setup and back (JiraView itself does not unmount on a page switch).
 *
 * The slot holds the issue AND the board's lane index as it stood at the click (`childrenOf`, grouped-board spec §6), which the modal's Children tree hangs
 * grandchildren from. A tree-row click swaps the one modal's issue and carries the same snapshot forward — never a second modal — but it PUSHES onto the
 * walk rather than replacing the slot, so the modal's head can offer `← <the issue before>` and a reader who went three children deep can climb back out
 * without closing and reopening the card (DESIGN.md §8.9.2, Head). A page's open always starts a fresh walk: a card click is a new reading, not a step of
 * the last one.
 *
 * **The write counter is held here too** (Jira phase 3, plan ruling R7). The modal's landed write — `Assign to me`, `Move to…` — calls `onWrote`,
 * which bumps `nudge`; the Board and Sessions pages hand it to `useJiraBoard`, whose list re-reads at once on the change, `off` boards included. The two never reach
 * into each other: this component is the one place that holds both the modal and the page, so it is the one place a number can pass between them. The
 * counter is not cleared on a page switch — it is a count of events, not a state, and only its change means anything.
 *
 * **The launch sheet is held HERE too, ONE for the whole section** (Jira phase 5, spec §7; the task-10 brief put it on the board page and this is the
 * deliberate deviation). `Run ▾` is drawn in two homes, a card and the modal, and both call `onRun(issue, action)`; the sheet they open has to rank ABOVE an
 * open modal on the one dialog stack — Escape then closes the sheet alone and the modal stays, with no second key listener. What ranks it there is MOUNT
 * ORDER, which is what `useDialogEscape` ranks by: the sheet always opens while the modal is already up (a pick in the modal's own `Run ▾`, or in a card's menu
 * with the modal open behind it), so it mounts later whatever its place in the JSX. It is drawn after the modal anyway, for the reader of this file, but
 * reordering the two lines would change nothing; hosting it in the one component that holds both is what guarantees a single sheet and a single slot.
 * `onStarted` is a landed Start and `onWrote` a Start refused after the server's writes landed: both are `landed` — reload the shell's status (the strip is
 * `live`, and the status poll alone runs on the boards' clock, minutes away) AND the sessions payload, and bump `nudge`, because the ticket may have been
 * assigned and moved either way. Like the open issue, the slot is cleared whenever `page` changes.
 *
 * **The ticket page** (Jira detail tabs spec §2) is the fifth page, `JiraTicketPage`, drawn while the page is `ticket` and the key store holds a key. `ticket`
 * with an empty key is not a page: this draws the Board for it and writes `board` back in one effect, so the rail never highlights a row it does not draw.
 * `openPage` is every in-app way in — the modal's `Open full page ↗` and a Cmd-, Ctrl- or middle-click on a card, row or deck title: it computes the ORIGIN
 * (the page it was called from) first, hands it to the key store's setter with the key (the store's setter, as the two-writer rule asks — its none → key
 * push records the origin in the new entry's `history.state`), and only then moves the page, which closes the modal through the page-change reset below.
 * The origin is the key store's, beside the key (Jira ticket URL spec), not this component's memory: `App`'s popstate listener has to read it to send a
 * Back press to the page the ticket came from, and a reload re-reads it from the entry's state, so a ticket opened from Sessions says `← Sessions` after a
 * reload and a remount too. A pasted link carries no state and says `← Board`. The address (`?section=jira&ticket=<KEY>`) is `App`'s to load and to keep
 * in step with the screen; nothing here touches it except through the store. The page shares the launch sheet and `nudge` with the board pages and opens no
 * modal of its own; the mention modal opens over it from its strip's `@ N` (below).
 *
 * **The mention modal's slot is HERE too** (Jira mentions <-> board link, §4; DESIGN.md §8.9.7). `mentionOpen` holds the opened snapshot `{ issue, mention }`,
 * set by an `@ N` mark through `MentionOpenContext` (provided around the pages AND the Detail, so a marker in a card, a lane header, a list row or the Detail's
 * strip all reach the same opener) and cleared with `walk` and `launch` on a page change. `MentionModalHost` draws it after the Detail and before the launch
 * sheet. The board's walk is derived on every render from the live payload — the ticket's current `mentions` (newest first), the shown mention's place in it,
 * and no position or neighbours once that mention has left it (a Dismiss, a posted reply) — so a poll never closes the dialog from under the reader. **It
 * never opens over another modal**: every `Modal` paints on one tier and the reply editor already owns the next, so the opener empties the Detail walk in the
 * same handler that sets the slot — the strip's mark SWAPS the ticket modal for the mention modal, and Escape then returns to the page beneath.
 */
type OpenSlot = { issue: JiraIssue; childrenOf: JiraChildrenIndex | null };

export default function JiraView({ onOpenJiraPage }: { onOpenJiraPage: (p: JiraPage) => void }) {
  const { data, error, reload } = useJiraContext();
  const { reload: reloadSessions } = useJiraSessionsContext();
  const [page] = useJiraPage();
  const ticketKey = useJiraTicketKey();
  // `ticket` with no key draws the Board (below) and is written back to `board` once, so the stored page agrees with what is on screen.
  const noTicket = page === 'ticket' && ticketKey === '';
  useEffect(() => {
    if (noTicket) setJiraPage('board');
  }, [noTicket]);
  // The page the ticket was opened from, held by the key store beside the key (and in the entry's `history.state`), so `App`'s popstate can read it.
  const origin = useJiraTicketOrigin();
  // The origin is computed BEFORE the key store write, because that write is the push that records it in the new entry's state.
  const openPage = (key: string): void => {
    const from: TicketOrigin = page === 'sessions' || page === 'mentions' ? page : 'board';
    setJiraTicketKey(key, from);
    onOpenJiraPage('ticket');
  };
  const openPageOn = (issue: JiraIssue): void => openPage(issue.key);
  // The walk: the issue opened from a page, then every Children row clicked from there, the last one shown. A page's open STARTS a walk (one entry), a
  // tree-row click pushes, the head's Back chip pops, and a close empties it — so `[]` is "no modal" and there is no separate null slot to disagree with it.
  const [walk, setWalk] = useState<readonly OpenSlot[]>([]);
  const openOne = (issue: JiraIssue, childrenOf: JiraChildrenIndex | null): void => setWalk([{ issue, childrenOf }]);
  const openChild = (issue: JiraIssue, childrenOf: JiraChildrenIndex | null): void => setWalk((w) => [...w, { issue, childrenOf }]);
  const openIssue = walk.length === 0 ? null : walk[walk.length - 1];
  const cameFrom = walk.length < 2 ? null : walk[walk.length - 2].issue;
  // The slot is JiraView's, and JiraView does not unmount on a page switch, so leaving the Board must clear it by hand — otherwise returning to Board would
  // redraw the modal for an issue the reader closed the page on.
  useEffect(() => setWalk([]), [page]);
  // The mention modal's slot: the opened snapshot, never a live copy — `MentionModalHost` re-reads the entry from the payload on every render.
  const [mentionOpen, setMentionOpen] = useState<{ issue: JiraMentionIssue; mention: JiraMention } | null>(null);
  useEffect(() => setMentionOpen(null), [page]);
  const mentionIndex = useMentionIndex();
  const { data: mentionsData } = useJiraMentionsContext();
  // An opener for a key with no open entry does nothing; otherwise the walk is emptied in the same handler (never two modals), and the newest mention is shown.
  const openMention = (key: string): void => {
    const entry = mentionIndex.get(key);
    if (entry === undefined || entry.mentions.length === 0) return;
    setWalk([]);
    setMentionOpen({ issue: entry, mention: entry.mentions[0] });
  };
  const liveMentions =
    mentionOpen === null || mentionsData === null || !mentionsData.configured
      ? []
      : (mentionsData.issues.find((i) => i.key === mentionOpen.issue.key)?.mentions ?? []);
  const mentionAt = mentionOpen === null ? -1 : liveMentions.findIndex((x) => x.commentId === mentionOpen.mention.commentId);
  const stepMention = (to: number): void => {
    if (mentionOpen !== null && liveMentions[to] !== undefined) setMentionOpen({ issue: mentionOpen.issue, mention: liveMentions[to] });
  };
  const [launch, setLaunch] = useState<{ issue: JiraIssue; action: JiraAction; review?: ReviewLaunch } | null>(null);
  useEffect(() => setLaunch(null), [page]);
  const [nudge, setNudge] = useState(0);
  const run = (issue: JiraIssue, action: JiraAction): void => setLaunch({ issue, action });
  // The CodeRabbit row's button (spec §5.4): the same sheet, pre-set to `review` on one MR. Reached from Detail's Delivery pane only, so `Run ▾` never offers it.
  const runReview = (issue: JiraIssue, half: ReviewHalf, mr: GitlabMr, repos: string[]): void =>
    setLaunch({ issue, action: 'review', review: { half, mr: { project: mr.project, iid: mr.iid, sourceBranch: mr.sourceBranch }, repos } });
  // A review skill from the same row's `Review menu`: the same sheet, its action the skill and its `review` the skill variant on that MR — never `Run ▾`'s
  // sheet, which offers run skills only (review skills spec §5).
  const runReviewSkill = (issue: JiraIssue, skillId: string, mr: GitlabMr, repos: string[]): void =>
    setLaunch({ issue, action: { skill: skillId }, review: { skill: skillId, mr, repos } });
  // A Start that landed, or a Start refused after the server's writes landed (the ticket moved either way): reload the shell's status, nudge the board, and
  // re-ask the sessions payload too — Detail's `sessionLive` and the List's `canRun` read it, and left to its own 15 s clock they would offer Start again
  // on a ticket the server now holds a run on (the Run gate's 409).
  const landed = (): void => {
    reload();
    void reloadSessions();
    setNudge((n) => n + 1);
  };

  if (data === null) return <div className="board-empty">{error ? 'Jira unavailable' : 'loading…'}</div>;
  if (!data.configured) return <div className="board-empty">Jira is not configured</div>;
  return page === 'setup' ? (
    <JiraSetupView onOpenJiraPage={onOpenJiraPage} />
  ) : (
    // The sessions poll is the shell's (`App` hoists `JiraSessionsProvider` around the rail and this section): the card's `Run ▾`, the Detail dialog and the
    // rail badge read ONE payload, so none of them disagrees with another for a poll. This section being current is what `open` says there.
    <MentionOpenContext.Provider value={openMention}>
      {page === 'sessions' ? (
        <JiraSessionsView onOpenJiraPage={onOpenJiraPage} onOpenIssue={openOne} onOpenPage={openPageOn} onRun={run} nudge={nudge} />
      ) : page === 'mentions' ? (
        <JiraMentionsView onOpenJiraPage={onOpenJiraPage} onOpenPage={openPage} />
      ) : page === 'ticket' && !noTicket ? (
        <JiraTicketPage
          origin={origin}
          onLeave={() => onOpenJiraPage(origin)}
          onWrote={() => setNudge((n) => n + 1)}
          onRun={run}
          onReview={runReview}
          onReviewSkill={runReviewSkill}
        />
      ) : (
        <JiraBoardView onOpenJiraPage={onOpenJiraPage} onOpenIssue={openOne} onOpenPage={openPageOn} onRun={run} nudge={nudge} />
      )}
      {openIssue !== null && (
        <JiraDetail
          issue={openIssue.issue}
          childrenOf={openIssue.childrenOf}
          onOpenIssue={openChild}
          back={cameFrom}
          onBack={() => setWalk((w) => w.slice(0, -1))}
          onWrote={() => setNudge((n) => n + 1)}
          onRun={run}
          onReview={runReview}
          onReviewSkill={runReviewSkill}
          onOpenPage={openPage}
          onClose={() => setWalk([])}
        />
      )}
      {mentionOpen !== null && (
        <MentionModalHost
          issue={mentionOpen.issue}
          mention={mentionOpen.mention}
          position={mentionAt < 0 ? null : { at: mentionAt + 1, of: liveMentions.length }}
          onPrev={mentionAt > 0 ? () => stepMention(mentionAt - 1) : null}
          onNext={mentionAt >= 0 && mentionAt < liveMentions.length - 1 ? () => stepMention(mentionAt + 1) : null}
          onClose={() => setMentionOpen(null)}
          // The modal has already closed itself; the slot is emptied here too so the handler stands alone. On the ticket page of this very ticket there is
          // nowhere to go, so closing is all it does.
          onOpenPage={(key) => {
            setMentionOpen(null);
            if (page !== 'ticket' || ticketKey !== key) openPage(key);
          }}
        />
      )}
      {/* Drawn after the modal; it ranks above it because it mounts later — see the header. Keyed by issue so a second launch never inherits the first's form. */}
      {launch !== null && (
        <JiraLaunchSheet
          key={launch.issue.key}
          issue={launch.issue}
          initialAction={launch.action}
          review={launch.review}
          onClose={() => setLaunch(null)}
          onStarted={landed}
          onWrote={landed}
        />
      )}
    </MentionOpenContext.Provider>
  );
}
