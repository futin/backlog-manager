import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useJiraSessionsContext } from '../../hooks/JiraSessionsContext';
import { useAction } from '../../hooks/useAction';
import { useFetched } from '../../hooks/useFetched';
import { useNow } from '../../hooks/useNow';
import { useParentRead } from '../../hooks/useParentRead';
import { useSettings } from '../../hooks/useSettings';
import {
  displayPath,
  failureOf,
  fetchJiraDetail,
  fetchJiraWorktrees,
  initialsOf,
  issueDatesLine,
  modalTree,
  priorityTone,
  progressLine,
  repoBasename,
  resolveJiraAction,
  stopJira,
  ticketWorktrees,
  statusTone,
  transitionOptions,
  typeTone,
  unlinkJira,
  type JiraChildrenIndex
} from '../../lib/jira';
import { childSessions, type DeckEntry } from '../../lib/jira-deck';
import { parentLineText, parentLiveLine } from '../../lib/jira-parent';
import { ticketSessions, type SessionLink } from '../../lib/jira-sessions';
import { sessionTone } from '../../lib/tones';
import { pollAge } from '../../lib/tracker';
import { elapsedSince } from '../../lib/item-age';
import { renderMarkdown } from '../../lib/markdown';
import { STATE_LABEL, type JiraSessionState } from '../../../../shared/jira-sessions';
import { JIRA_BUILTIN_LABELS } from '../../../../shared/types';
import type { JiraAction, JiraIssue, JiraTransition, JiraIssueDetail, JiraWorktree, JiraWorktreesPayload } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Fact } from '../ui/Fact';
import { Glyph } from '../ui/Glyphs';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Modal } from '../ui/Modal';
import { Chevron } from '../ui/Chevron';
import { Pill } from '../ui/Pill';
import { Popover } from '../ui/Popover';
import { SpreadBar } from '../ui/SpreadBar';
import { JiraRunMenu } from './JiraRunMenu';
import { JiraHistoryLine, JiraSessionCard, JiraStartingCard } from './JiraSessionCard';
import { WorktreeRow } from './JiraWorktreeRow';
import { useTimeZone } from '../../hooks/TimeZoneContext';

/**
 * JiraDetail — one Jira issue's Detail dialog: the ticket's agent sessions on the left, the ticket itself on the right (Jira sessions spec §7.3, §8), with the
 * board's two writes to Jira itself (Jira phase 3) and its session controls (Jira phase 5) — spec §6.3, §7; DESIGN.md §8.9.2, which applies §8.7's sidecar to
 * a Jira issue. It replaced the Jira issue modal, and everything that modal showed and did is still here, regrouped.
 *
 * **It is the item modal's twin, not a second dialog design.** It composes `ui/Modal` exactly as `board/ItemModal.tsx` does — so the scrim, the close
 * control, the Escape key (the LIFO stack in `useDialogEscape`, called by the shell and never here) and the 700 px fold are the shell's — and takes the
 * modal's slot on that stack, so the count of dialogs does not change. `Modal`'s composer list is `[ItemModal, JiraDetail]` and a third is a design change.
 * It passes `Modal` a `head`, which is the shell's split shape (`Detail.dc.html`): the head carries the type, key, parent and sprint as crumbs, the link out
 * and the title; the facts slot holds the AGENT — one `JiraSessionCard` per live session, newest first, then the history, then `Run ▾`; the body holds the
 * TICKET — a facts pane with the two writes beside the facts they change, then the description, children and worktrees panes and the comments note.
 *
 * **The left column is the sessions page's, not the status'.** The cards and the history read `useJiraSessionsContext()` (`GET /api/jira/sessions`, one poll
 * for the whole Jira section), narrowed to this key by `ticketSessions`. A `starting` Run is the one thing that payload never carries — a reservation has no
 * link until the dashboard answers — so its "Starting…" card is drawn from the shell's `live[key]`, which is where `reserve` puts it. Unlink (only a `branch`
 * link) and Stop (only a row with `stopState`) are offered by the card; the POSTs are this dialog's, through the one write guard below, and a landed one
 * reloads the status AND the sessions payload so the card goes without waiting for the timer. Stop names the session (`{ key, sessionId }`): a ticket can
 * hold several, and the server ends only the one it is told.
 *
 * **`Run ▾`** (`JiraRunMenu`, the card's own chip) → `onRun(issue, action)`; the launch sheet is hosted by `JiraView`, ABOVE this dialog, so Escape closes the
 * sheet alone and the dialog under it on the next press. It sits in the Agent band at the column's top (restyle §4.4) — on the empty state's row, or on the label row with `Next session takes over once this one ends.` beside it — and `runChipState`
 * disables it only while a `run` link is live (the one-run gate, §5) or a reservation is `starting`; a live `branch` or `manual` link does not. It is never hidden.
 *
 * **The write controls** (Jira phase 3; spec §6.3, §8; DESIGN.md §8.9.2) sit beside the fact each one changes, as the mock draws them — `Move to…` after the
 * status pill, `Assign to me` after the assignee:
 *
 * - **`Assign to me`**, a 28 px `Chip` → `POST /api/jira/issue/assign` `{ key }`. Disabled, with the reason as its title, while the shell's status knows
 *   no identity (`data.me` null — which also covers a boot `myself` that has not answered: the server would refuse with 503 `no identity` anyway, and
 *   §8's reason it must is that Jira reads `{ accountId: null }` as UNASSIGN) and while the issue is already the reader's own (`already assigned to you`).
 * - **`Move to`**, the Status chip (28 px `Chip`: a toned dot, the raw status name, a chevron) → a 240 px `Popover` of one row per transition → `POST
 *   /api/jira/issue/transition` `{ key, transitionId }`. Rows are named by the status they land in (`transitionOptions`: `to.name`, or the transition's own
 *   name only when two land in one status); every row landing on the CURRENT status is pinned first and `aria-disabled`. A pick posts AT ONCE and closes the
 *   panel — there is no confirm step. Disabled until the detail lands (the transitions are the detail's, and the card carries none), with `transitions
 *   unavailable` as the title once that read failed, and `no transitions offered` when Jira offers none. The eighth `Popover` composer.
 *
 * **The Worktrees list** (Jira repo/branch, spec §5.5; DESIGN.md §8.9.2) sits under the body and above the comments note, independent of the detail read: the
 * trees come from `GET /api/jira/worktrees`, which this dialog asks for itself — on open, and again when the key changes or a session on it starts or ends
 * (the moments a tree is made or becomes safe to remove) — and `ticketWorktrees` narrows to this key's. The main tree never gets a row. A failed read, or
 * no tree, draws no heading at all; the previous answer for the same key stays drawn while a re-read is out, so the list does not blink on a Stop. Each row's
 * `Remove` COPIES `removeCommand` — the board never writes git — and is disabled, titled `a session is running on <KEY>`, while any session is live on the
 * key, a detected `branch` one included (it is running IN a worktree). That check is the best the board can do: a session it has no link for (Copy prompt, a
 * terminal on a branch the detector cannot read) is invisible to it, which the enabled title says in so many words.
 *
 * **The `session` fact** reads the newest live session — `<name> · <repo basename> · <elapsed>`, `starting`, or `—` — from the sessions payload, and from the
 * shell's `live[key]` while that payload has not landed, rather than from the detail's `session`, which stays typed `null`: both are already polled, and the
 * detail read would add a third source for one fact. The elapsed reading ticks with `useNow` — the card strip's own clock — so it keeps counting while the
 * dialog stays open.
 *
 * **One write at a time, stamped with its key.** Every write — Assign, Move, Stop, Unlink — fires through ONE `useAction`, so its ref guard (bug-19's layer 1,
 * the reason DESIGN.md §8.4.1 gives `RunControls`) holds across all of them: a double click on Assign, or a Move picked while Assign is out, sends nothing —
 * two clicks inside one tick both read a `disabled` that has not been painted yet, and only a ref sees the first. The controls are disabled while a write is
 * out, the rendering half of that guard; and they stay disabled across a Children-row swap until it settles, because one dialog sends one write (plan ruling
 * R6 leaves the serialisation to this dialog). Each write carries the key it was sent for, and its settle compares that against the key the dialog shows NOW
 * (`keyRef`): a refusal for an issue the reader has swapped away from is dropped (`onError` → `true`, "handled"), never drawn under another issue's title, and a
 * landed write's detail re-read is skipped for the same reason. The status reload and the board nudge are NOT skipped: the write happened, and both of
 * those describe the board, not the dialog's issue.
 *
 * **A failure says why, in place.** The server's sentence (`{ error }`), else `HTTP <status>`, else the network's own message — `failureOf`'s rule, the
 * same one the read uses — in a `role="alert"` line under the ticket's write row. The dialog stays open: a refusal (`Jira refused: …`, `transition not
 * offered`, an unlink of a Run link) is something to read and maybe retry, not a reason to lose the place. The line clears when the next write leaves
 * (`useAction` clears it) and when the key changes (cleared during render, so the new issue's first frame never carries the old one's refusal).
 *
 * **A landed write re-reads three things** (spec §6.1; rulings R7, R8): the shell's status (`useJiraContext().reload()`), the board's list (`onWrote`,
 * which bumps `JiraView`'s nudge), and this dialog's own detail. A 200 with `reread: false` is a success like any other: it says the SERVER's re-read
 * failed after the write stood, the next sweep catches its cache up, and an error here would invite a retry of a write that already happened (R1). The
 * detail re-read is a `rev` counter in `useFetched`'s deps — which answers `PENDING` on any dep change — so the last detail that landed for this SAME key
 * is held here and drawn while the re-read is out (R8): no `loading…` flash, and no controls blinking to disabled-for-no-detail and back.
 *
 * **Two sources, one column.** The card hands over the `JiraIssue` it was drawn from, and every fact the card already carries is drawn from it at once —
 * the dialog opens with a full column rather than a spinner. The detail (`GET /api/jira/issue/:key`, read fresh on open) then supplies the three things a
 * card cannot: the description, the children, and the boards that hold the issue; it also replaces the card's copy, which may be one poll old. A failed read
 * leaves the card's facts exactly as they were and says so where the body would be, with the server's own sentence (`could not read the ticket — Jira
 * unreachable: timeout`), because a column that blanked on a Jira blip would take the readable half down with the unreadable one.
 *
 * **The browser never talks to Jira.** The one request is to `/api/jira/issue/…`; the link out is the issue's `url` as the SERVER built it, rendered as
 * given in a new tab with no referrer, and the description goes in through `renderMarkdown` — the sanitising renderer that never emits raw HTML as markup and refuses a
 * `javascript:` href (see its header), which matters more here than on a backlog item, because this text was typed by anyone with access to the Jira site.
 *
 * **State belongs to a key.** The held answer is stamped with the issue key it was read for, and only that key's answer is read: reopening the dialog on
 * another issue while a read is in flight never paints the first issue's description under the second one's title, and a late answer for a key the dialog
 * has left is dropped. Facts that come from the detail (`on boards`) are simply absent while the held answer is for another key — and also once it has landed, if none of the
 * boards it names is one the shell's status knows (a board deleted a moment ago): the spec lists the fact unconditionally, but a label with nothing under it is
 * the empty fact `Fact`'s own header says never to draw.
 *
 * Repositories are read from the shell's one status (`useJiraContext`): the mapped paths for the issue's PROJECT key through `displayPath` (the same `~`
 * reading the Setup card gives), or the hint that says where to map one. The `created · updated` line (`issueDatesLine`), the session fact and every age on
 * the cards read the one `useNow` clock, a minute's tick.
 *
 * **The parent is a link, read on demand** (spec `2026-11-11-jira-run-on-parent-design.md` §4.1, §4.3; DESIGN.md §8.9.2). An issue with a parent — a
 * sub-task's story, a story's epic — draws the head crumb's `<KEY> <summary>` and the `Parent` fact as one link-skinned button, and a click PUSHES the parent
 * onto `JiraView`'s walk exactly as a Children row does (`onOpenIssue(parent, childrenOf)`, the board's snapshot carried forward). The walk wants a whole
 * `JiraIssue` and the issue knows only `{ key, summary }` of its parent, so the click reads `GET /api/jira/issue/:key` through `useParentRead` — the read
 * shared with this dialog's `Run ▾` (one per parent key: a link click then a menu pick is one request) and held while the dialog is open. It is a READ, so
 * it does not take `useAction`'s guard: a Move or Assign may be out while the parent loads. While it is out the link is inert and `aria-busy`; an answer
 * that lands after the dialog swapped to another key is dropped (`keyRef`), never pushed; a failure is the read's own `role="alert"` line, under the write
 * row and after the write error when both show, cleared by the next click (which reads again — a failure is never cached) and by a key swap
 * (`parentAskedFor`, reset during render with the write error). A failure in the MENU's read draws only the menu's note, never this line: the read is shared,
 * its failure is shown per surface.
 *
 * **The parent-live line.** For a sub-task — `type.subtask` with a parent, the `Run on` toggle's own condition, so a story under a live epic draws none — the
 * Agent band adds `Parent <KEY> · <state> · <repo> →` (`parentLiveLine`, `parentLineText`) when the sessions payload holds a live session on the parent:
 * the parent's newest live session leads and the rest are `+N more`. It needs no read (the payload carries every key's links, which is why it draws for a
 * parent on no board), and its click is the link's. It sits under the empty band's sub-line, before any `ChildSessionLine`, or directly under the live
 * band's label row, above the cards.
 *
 * **Children are a tree, and a row swaps THIS dialog's issue** (DESIGN.md §8.9.2; grouped-board spec §6). The detail's `children` are the direct children,
 * fresh; under each hang its descendants from `childrenOf`, the board's fold index as it stood when the card was clicked (`modalTree`). That snapshot is not
 * refreshed by later board polls: the tree costs no Jira call beyond the one read this dialog already makes, and a row a poll moved is at worst one poll old
 * while the direct children never are. `null` (no board behind the dialog) draws the direct children only. The head row counts the DIRECT children in its
 * pill and says `N in all` only when the tree draws more rows than that; the spread bar counts the rows as drawn. No filter marking inside the tree — the
 * filter ring is the card's (spec §8 non-goal). A row click hands the row's issue and the SAME snapshot to `onOpenIssue`, which is the very setter the board
 * calls, so `JiraView` swaps the one dialog's issue and the keyed read below fetches the new detail. Never a second `Modal`: Escape has one owner, and a
 * stack of issue dialogs would make it close one layer of a walk the reader thinks of as one dialog. The walk is `JiraView`'s, not this dialog's: it hands
 * down `back`, the issue one step up, and the head draws `← <key>` while there is one; a press pops one step and the same keyed read re-fetches that issue.
 * Escape still closes the whole dialog — Back is a step, close is leaving.
 */

type Held = { detail: JiraIssueDetail } | { failure: string };

/**
 * POSTs one issue write and resolves when it LANDED. A non-OK answer rejects with `failureOf`'s sentence, and a dropped request rejects with the
 * network's own error, so `useAction`'s `errorMessage` renders exactly the three readings the header names. The 200's body (`JiraIssueWriteResult`) is
 * not read: `reread` changes nothing here (see the header), and a body that failed to parse after a 200 must not turn a write that stood into an error.
 */
async function postWrite(path: 'assign' | 'transition', body: Record<string, string>): Promise<void> {
  const res = await fetch(`/api/jira/issue/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await failureOf(res));
}

export function JiraDetail({
  issue,
  childrenOf,
  onOpenIssue,
  back,
  onBack,
  onWrote,
  onRun,
  onClose
}: {
  issue: JiraIssue;
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  /** The issue a Children-row click came FROM, or `null` on the issue the walk started at — the head draws `← <key>` only when there is one. */
  back: JiraIssue | null;
  onBack: () => void;
  onWrote: () => void;
  /** `Run ▾`'s pick — the page opens the launch sheet over this dialog. */
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  onClose: () => void;
}) {
  const { zone } = useTimeZone();
  const { data, reload } = useJiraContext();
  const { data: sessions, reload: reloadSessions } = useJiraSessionsContext();
  const { settings } = useSettings();
  const { busy, error: writeError, run, clearError } = useAction();
  // The key the dialog shows NOW, read by a write's settle (see the header) — a ref, because the settle closure was made on the render that sent it.
  const keyRef = useRef(issue.key);
  keyRef.current = issue.key;
  // Bumped by a landed write for the key still shown: it only TRIGGERS the re-read; the held detail below is what keeps the body up meanwhile (R8).
  const [rev, setRev] = useState(0);
  // A refusal belongs to the issue it was sent for. Cleared DURING render on a key change (React's "adjust state when a prop changes"), so the swapped-in
  // issue's first frame never draws it; a late refusal for the old key is dropped by the settle, so nothing re-raises it.
  const [shownKey, setShownKey] = useState(issue.key);
  // The last detail that LANDED — R8's held copy, drawn only while a read for that same key is pending again (a write's re-read). Stored during render on
  // the frame it lands, for the reason `useFetched` tags its answer: an effect would store it one commit late, and that commit would draw `loading…`.
  const [kept, setKept] = useState<JiraIssueDetail | null>(null);
  // The key whose parent link was last clicked: the parent read's failure line shows only for it, so a swap to a sibling under the same parent (whose hook
  // read would otherwise carry over) opens clean.
  const [parentAskedFor, setParentAskedFor] = useState<string | null>(null);
  if (shownKey !== issue.key) {
    setShownKey(issue.key);
    clearError();
    setParentAskedFor(null);
    // Dropped on a key change too, so a walk back to an issue (A → B → A) opens on `loading…` like any open, not on A's copy from before the walk.
    setKept(null);
  }

  // Keyed on the issue and the write revision: swapping to a child reads nothing held on the very render that carries the new key, and a superseded answer
  // never lands (`useFetched`, #285). Every failure — a non-OK answer, a malformed body, a dropped request — resolves to a `failure`, so the read itself
  // never rejects.
  const { value: mine } = useFetched(
    () =>
      fetchJiraDetail(issue.key)
        .then((detail): Held => ({ detail }))
        .catch((e: unknown): Held => ({ failure: e instanceof Error ? e.message : String(e) })),
    [issue.key, rev]
  );

  // This ticket's sessions, and the shell's reservation for it — `starting` is the one state only the status knows (see the header).
  const { live: liveLinks, ended } = ticketSessions(issue.key, sessions);
  const reserved = data?.live[issue.key] ?? null;
  const starting = reserved !== null && reserved.starting ? reserved : null;
  // The Worktrees list's read: keyed on the issue and on WHETHER a session is live on it (not on the session object, which a status poll replaces).
  const sessionLive = starting !== null || liveLinks.length > 0 || (sessions === null && reserved !== null);
  const trees = useFetched(() => fetchJiraWorktrees(), [issue.key, sessionLive]);
  const keptTrees = useRef<{ key: string; payload: JiraWorktreesPayload } | null>(null);
  if (trees.status === 'ok' && trees.value !== null) keptTrees.current = { key: issue.key, payload: trees.value };
  else if (trees.status === 'failed') keptTrees.current = null;
  const ticketTrees =
    keptTrees.current === null || keptTrees.current.key !== issue.key ? [] : ticketWorktrees(issue.key, keptTrees.current.payload);
  const landed = mine !== null && 'detail' in mine ? mine.detail : null;
  if (landed !== null && landed !== kept) setKept(landed);
  const detail = landed ?? (mine === null && kept !== null && kept.key === issue.key ? kept : null);
  const failure = mine !== null && 'failure' in mine ? mine.failure : null;
  // The detail's copy is the fresher one; the card's is what the column draws until it lands (or for good, when the read fails).
  const src: JiraIssue = detail ?? issue;
  // The Children tree, once here rather than inside `ChildrenTree`, because two places read it: the tree draws its rows, and the agent band's empty shape says
  // which of them a session is live on. `underway` is the deck's own reading over those rows (`childSessions`), so a row and the band cannot disagree.
  const tree = detail === null || detail.children.length === 0 ? null : modalTree(detail.key, detail.children, childrenOf);
  const underway = tree === null ? [] : childSessions(tree.rows.map((r) => r.issue), sessions, data?.live ?? {});

  // `useNow`, like the card strip's: every age on the cards, the session fact's elapsed reading and `created · updated` tick while the dialog sits open
  // between polls.
  const now = useNow(true);
  const boardNames = detail === null || data === null ? [] : data.boards.filter((b) => detail.boards.includes(b.id)).map((b) => b.name);
  const paths = data?.repos[src.project.key] ?? [];
  // The parent link (see the header): one read shared with the Run menu, a push onto the walk when it lands for the key still shown.
  const parent = src.parent;
  const { read: parentRead, ask: askParent } = useParentRead(parent === null ? null : parent.key);
  const parentBusy = parentRead.state === 'loading';
  const parentError = parentRead.state === 'failed' && parentAskedFor === issue.key ? parentRead.error : null;
  const openParent = (): void => {
    if (parentBusy) return;
    const asked = issue.key;
    setParentAskedFor(asked);
    void askParent().then((p) => {
      if (p !== null && keyRef.current === asked) onOpenIssue(p, childrenOf);
    });
  };
  // One element drawn twice — the head crumb and the `Parent` fact. A stub's parent summary is `''`, so the label never ends on a stray space.
  const parentLink =
    parent === null ? null : (
      <button type="button" className="jira-detail-parent" aria-busy={parentBusy || undefined} aria-disabled={parentBusy || undefined} onClick={openParent}>
        {[parent.key, parent.summary].filter((p) => p !== '').join(' ')}
      </button>
    );
  const parentLine = parentLiveLine(src, sessions);
  const parentLineEl =
    parentLine === null || parent === null ? null : <ParentSessionLine parentKey={parent.key} lead={parentLine.lead} more={parentLine.more} onOpen={openParent} />;

  const me = data?.me ?? null;
  const assignBlock = me === null ? 'no identity' : src.assignee?.accountId === me.accountId ? 'already assigned to you' : null;
  const moveBlock = failure !== null ? 'transitions unavailable' : detail !== null && detail.transitions.length === 0 ? 'no transitions offered' : null;
  const moveReady = detail !== null && detail.transitions.length > 0;
  const [moveOpen, setMoveOpen] = useState(false);
  const moveChip = useRef<HTMLButtonElement>(null);

  /** The one write path the two Jira controls take (see the header): one guard, one error line, one key stamp. */
  const write = (path: 'assign' | 'transition', body: Record<string, string>): void => {
    const asked = issue.key;
    run(() => postWrite(path, body), {
      onSuccess: () => {
        reload();
        onWrote();
        if (keyRef.current === asked) setRev((r) => r + 1);
      },
      // `true` is "handled — draw nothing": the refusal is for an issue this dialog no longer shows.
      onError: () => keyRef.current !== asked
    });
  };

  /**
   * A session write — Stop or Unlink — through the one write guard and error line (see the header). A landed one reloads the status and the sessions
   * payload — the card's way out — and nudges the board. They name the session the card shows: a ticket can hold several, and the server ends only the one
   * it is told.
   */
  const sessionWrite = (send: (key: string) => Promise<void>): void => {
    const asked = issue.key;
    run(() => send(asked), {
      onSuccess: () => {
        reload();
        void reloadSessions();
        onWrote();
      },
      onError: () => keyRef.current !== asked
    });
  };

  const newest = liveLinks[0] ?? null;
  const sessionLine =
    starting !== null
      ? 'starting'
      : newest !== null
        ? [newest.name, repoBasename(newest.repo), elapsedSince(newest.startedAt, now)].filter((p) => p !== null).join(' · ')
        : sessions === null && reserved !== null
          ? [reserved.name, repoBasename(reserved.repo), elapsedSince(reserved.startedAt, now)].filter((p) => p !== null).join(' · ')
          : '—';
  const liveCount = liveLinks.length + (starting !== null ? 1 : 0);
  // The empty band's sub-line: the default action's label (the Run menu's own resolution) and, when the ticket was ever run, how long ago the newest end was —
  // `ended` is newest-`endedAt` first, the same list History draws. No repository here: the Ticket pane's `Repository` row is the one place paths are written.
  const defaultAction = resolveJiraAction(settings.jiraDefaultAction, data?.skills ?? []);
  const defaultLabel = typeof defaultAction === 'string' ? JIRA_BUILTIN_LABELS[defaultAction] : (data?.skills.find((k) => k.id === defaultAction.skill)?.name ?? '');
  const lastRun = ended.length > 0 ? pollAge(ended[0].endedAt, now) : null;
  const bandSub = `default: ${defaultLabel}${lastRun === null ? '' : ` · last run ${lastRun}`}`;
  const runControl = <JiraRunMenu issue={issue} home="modal" onPick={onRun} />;

  // The agent column — `Modal`'s facts slot. Cards newest first; the reservation, being newest of all, leads.
  const agent = (
    <div className="jira-detail-agent">
      <div className="jira-detail-agent-band">
        {liveCount > 0 ? (
          <>
            {/* The Run's wrapper is the menu's positioning parent (`.jira-detail-agent-row`), so the panel hangs under the row and not under the whole band. */}
            <div className="jira-detail-agent-row">
              <div className="jira-detail-lbl">
                Agent
                <span>{`${liveCount} live · ${ended.length} ended`}</span>
              </div>
              <span className="jira-detail-next">Next session takes over once this one ends.</span>
              {runControl}
            </div>
            {parentLineEl}
            {starting !== null && <JiraStartingCard session={starting} now={now} />}
            {liveLinks.map((link) => (
              <JiraSessionCard
                key={link.sessionId ?? link.startedAt}
                link={link}
                now={now}
                busy={busy}
                onUnlink={(sessionId) => sessionWrite((key) => unlinkJira(key, sessionId))}
                onStop={(sessionId) => sessionWrite((key) => stopJira(key, sessionId))}
              />
            ))}
          </>
        ) : (
          <>
            <div className="jira-detail-lbl">
              Agent
              <span>{`0 live · ${ended.length} ended`}</span>
            </div>
            <div className="jira-detail-agent-row">
              <span className="jira-detail-agent-tile" aria-hidden="true">
                <Glyph name="robot" size={16} />
              </span>
              <div className="jira-detail-agent-text">
                <span className="jira-detail-agent-none">No session on this ticket</span>
                <span className="jira-detail-agent-sub">{bandSub}</span>
                {parentLineEl}
                {underway.length > 0 && (
                  <ChildSessionLine first={underway[0]} more={underway.length - 1} onOpen={() => onOpenIssue(underway[0].issue, childrenOf)} />
                )}
              </div>
              {runControl}
            </div>
          </>
        )}
      </div>
      {ended.length > 0 && (
        <>
          <div className="jira-detail-lbl">History</div>
          <ol className="jira-hist-list">
            {ended.map((link) => (
              <JiraHistoryLine key={`${link.sessionId ?? ''}\u0000${link.startedAt}`} link={link} now={now} />
            ))}
          </ol>
        </>
      )}
    </div>
  );

  // The head — `Modal`'s split shape (`Detail.dc.html`): the type glyph, key, type, parent and sprint as crumbs, the link out at the right, the title under them.
  const head = (
    <div className="jira-detail-head">
      <div className="jira-detail-crumbs">
        {/* One step up the walk (`JiraView` holds it): the key it lands on is the label, so the reader knows where Back goes before pressing it. */}
        {back !== null && (
          <Chip size={28} aria-label={`Back to ${back.key}`} title={`Back to ${back.key} ${back.summary}`} onClick={onBack}>
            <span aria-hidden="true">←</span> {back.key}
          </Chip>
        )}
        <span className="jira-card-type" data-tone={typeTone(src.type)} title={src.type.name}>
          <JiraTypeIcon type={src.type} />
        </span>
        <span className="jira-detail-key">{src.key}</span>
        {src.type.name !== '' && <span>{`· ${src.type.name}`}</span>}
        {parentLink !== null && (
          <span className="jira-detail-crumb-parent">
            <span className="jira-detail-crumb-in">{'· in '}</span>
            {parentLink}
          </span>
        )}
        {src.sprint !== null && src.sprint !== '' && <span>{`· ${src.sprint}`}</span>}
      </div>
      {/* A plain link, not a `Chip as="a"`: the chip carries no `target`, and this one must open a new tab with no referrer like every link out. */}
      <a className="jira-detail-out" href={src.url} target="_blank" rel="noreferrer">
        Open in Jira ↗
      </a>
      <h2 className="jira-detail-title">{src.summary}</h2>
    </div>
  );

  return (
    <Modal label={`${src.key} ${src.summary}`} head={head} facts={agent} onClose={onClose}>
      <div className="jira-detail-ticket">
        <div className="jira-detail-lbl">Ticket</div>
        <div className="jira-detail-pane">
          <dl className="jira-detail-facts">
            <Fact label="Status" icon={<Glyph name="ring" />}>
              <span className="jira-detail-status">
                <Chip
                  ref={moveChip}
                  size={28}
                  disabled={busy || !moveReady}
                  title={moveBlock ?? undefined}
                  aria-label="Move to"
                  aria-haspopup="dialog"
                  aria-expanded={moveOpen}
                  onClick={() => setMoveOpen((o) => !o)}
                >
                  <span className="jira-status-dot" data-tone={statusTone(src.status.category)} aria-hidden="true" />
                  {src.status.name}
                  <Chevron dir={moveOpen ? 'up' : 'down'} />
                </Chip>
                {moveOpen && moveReady && (
                  <Popover label="Move to" width={240} anchor={moveChip} onClose={() => setMoveOpen(false)}>
                    <JiraMoveRows
                      transitions={detail.transitions}
                      current={src.status.name}
                      onPick={(id) => {
                        setMoveOpen(false);
                        write('transition', { key: issue.key, transitionId: id });
                      }}
                    />
                  </Popover>
                )}
              </span>
            </Fact>
            <Fact label="Assignee" icon={<Glyph name="person" />}>
              <span className="jira-detail-assignee">
                {src.assignee !== null && (
                  <span className="jira-card-av" aria-hidden="true">
                    {initialsOf(src.assignee.name)}
                  </span>
                )}
                {src.assignee === null ? 'unassigned' : src.assignee.name}
              </span>
              <Chip size={28} disabled={busy || assignBlock !== null} title={assignBlock ?? undefined} onClick={() => write('assign', { key: issue.key })}>
                Assign to me
              </Chip>
            </Fact>
            {src.reporter !== null && <Fact label="Reporter" icon={<Glyph name="person" />}>{src.reporter}</Fact>}
            {src.priority !== null && src.priority !== '' && <Fact label="Priority" icon={<Glyph name="flag" />}>
                <span className="jira-card-prio" data-tone={priorityTone(src.priority)} title={`priority ${src.priority}`}>
                  {priorityTone(src.priority) !== 'other' && <Glyph name={priorityTone(src.priority) === 'high' ? 'up' : priorityTone(src.priority) === 'med' ? 'equals' : 'down'} size={10} />}
                  {src.priority}
                </span>
              </Fact>}
            {src.sprint !== null && src.sprint !== '' && <Fact label="Sprint" icon={<Glyph name="calendar" />}>{src.sprint}</Fact>}
            {parentLink !== null && <Fact label="Parent" icon={<Glyph name="branch" />}>{parentLink}</Fact>}
            {src.labels.length > 0 && <Fact label="Labels" icon={<Glyph name="tag" />}>
                {src.labels.map((l) => (
                  <span key={l} className="jira-detail-label">
                    {l}
                  </span>
                ))}
              </Fact>}
            <Fact label="Created · updated" icon={<Glyph name="calendar" />}>{issueDatesLine(src, now, zone)}</Fact>
            {boardNames.length > 0 && <Fact label="On boards" icon={<Glyph name="grid" />}>{boardNames.join(', ')}</Fact>}
            <Fact label="Repository" icon={<Glyph name="branch" />}>
              {data === null || paths.length === 0 ? (
                `no repository mapped for ${src.project.key} — Jira › Setup › Repositories`
              ) : (
                <span className="item-facts-path">{paths.map((p) => displayPath(p, data.home)).join(', ')}</span>
              )}
            </Fact>
            <Fact label="Session" icon={<Glyph name="play" />}>{sessionLine}</Fact>
          </dl>
          {writeError !== null && (
            <p className="jira-modal-error" role="alert">
              {writeError}
            </p>
          )}
          {/* The parent read's own failure (see the header) — after the write error, so both show and neither hides the other. */}
          {parentError !== null && (
            <p className="jira-modal-error" role="alert">
              {parentError}
            </p>
          )}
        </div>
        <div className="jira-detail-lbl">Description</div>
        <div className="item-body jira-detail-pane">
          {failure !== null ? (
            <div className="drawer-empty">{`could not read the ticket — ${failure}`}</div>
          ) : detail === null ? (
            <div className="drawer-empty">loading…</div>
          ) : detail.description.trim() === '' ? (
            <p className="jira-modal-none">no description</p>
          ) : (
            // Keyed on the issue, so a Children-row swap opens the next description collapsed rather than inheriting this one's `Show more`.
            <Description key={detail.key} markdown={detail.description} />
          )}
        </div>
        {detail !== null && tree !== null && (
          <div className="jira-detail-pane">
            <ChildrenTree
              direct={detail.children.length}
              tree={tree}
              underway={underway}
              childrenOf={childrenOf}
              onOpenIssue={onOpenIssue}
            />
          </div>
        )}
        {ticketTrees.length > 0 && (
          <div className="jira-detail-pane">
            <WorktreesList trees={ticketTrees} issueKey={issue.key} live={sessionLive} home={data?.home ?? null} />
          </div>
        )}
        <p className="jira-modal-comments">
          Comments stay in Jira — v1 neither reads nor writes them.{' '}
          <a href={src.url} target="_blank" rel="noreferrer">
            {`${src.key} in Jira ↗`}
          </a>
        </p>
      </div>
    </Modal>
  );
}

/**
 * The ticket's worktrees (header, "The Worktrees list"): one `WorktreeRow` per tree — branch, path and repo through `displayPath` — and a `Remove` that
 * copies the command and runs nothing (the row's own header says how). It is disabled while `live` — the shell knows of a session on this key — and its
 * title then names the key.
 */
function WorktreesList({ trees, issueKey, live, home }: { trees: readonly JiraWorktree[]; issueKey: string; live: boolean; home: string | null }) {
  return (
    <section className="jira-wt">
      <div className="jira-tree-head">
        <h3>Worktrees</h3>
        <Pill tone="neutral">{trees.length}</Pill>
      </div>
      <ul className="jira-wt-list">
        {trees.map((t) => (
          <WorktreeRow key={t.path} tree={t} home={home} liveKey={live ? issueKey : null} showRepo />
        ))}
      </ul>
    </section>
  );
}

/**
 * The description, collapsed to its first few lines (`.jira-desc`'s max-height) with a `Show more` under it — a long ticket otherwise pushes the Children
 * and everything after them a screen down, which is the very thing that makes Jira's own issue view hard to scan. The toggle is drawn only when the text
 * actually overflows the clamp, measured rather than guessed from a character count, because a short line of Markdown can render as a tall table and a
 * long one as a single paragraph. The measure re-runs when the content's own box changes (an image arriving, the modal folding under 700 px) where the
 * browser has a `ResizeObserver`; where it has none, the one measure after the HTML lands is what it gets.
 */
function Description({ markdown }: { markdown: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const html = renderMarkdown(markdown);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (box === null || content === null) return;
    // Measured against the clamp only while collapsed: expanded, the box is as tall as its content and would always read as fitting.
    const measure = (): void => {
      if (!box.classList.contains('open')) setOverflows(box.scrollHeight > box.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [html]);

  return (
    <>
      <div ref={outer} className={expanded ? 'jira-desc open' : overflows ? 'jira-desc clamped' : 'jira-desc'}>
        <div ref={inner} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {(overflows || expanded) && (
        <button type="button" className="jira-desc-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

/**
 * The Children section — head row, spread bar, tree — over `modalTree` (see the header). Drawn only when the detail has direct children. A row a session is
 * live on wears that session's state as a neutral `Pill` led by the state's dot (`underway`, one per row), before the ticket's own status pill: an epic's
 * List row can read `Working` for a sub-task's session, and this is where the reader finds which one.
 */
function ChildrenTree({
  direct,
  tree,
  underway,
  childrenOf,
  onOpenIssue
}: {
  direct: number;
  tree: ReturnType<typeof modalTree>;
  underway: readonly DeckEntry[];
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
}) {
  const { rows, progress } = tree;
  const live = new Map(underway.map((e) => [e.issue.key, e.state] as const));
  return (
    <>
      <div className="jira-tree-head">
        <h3>Children</h3>
        <Pill tone="neutral">{direct}</Pill>
        {rows.length > direct && <span className="jira-tree-all">{`${rows.length} in all`}</span>}
      </div>
      {/* Wrapped, because the spacing is this surface's and the primitive's own selectors stay in the ui block (design-guard 7). */}
      <div className="jira-tree-spread">
        <SpreadBar done={progress.done} doing={progress.doing} todo={progress.todo} caption={progressLine(progress)} />
      </div>
      <ul className="jira-tree">
        {rows.map(({ issue: row, depth }) => (
          // The indent is the one inline style: a depth is data, and a class per depth would cap how deep a tree may go.
          <li key={row.key} data-depth={depth} style={{ paddingLeft: depth * 22 }}>
            <button type="button" className="jira-tree-row" onClick={() => onOpenIssue(row, childrenOf)}>
              <JiraTypeIcon type={row.type} />
              {/* The spaces between the spans are what the button's accessible name reads as word breaks: `PAY-162 Ledger rounding fix`. */}
              <span className="jira-tree-key">{row.key}</span> <span className="jira-tree-summary">{row.summary}</span>{' '}
              {/* The card's own disc: initials or the empty one, never an image, so every row's status pill lines up. */}
              <span className={row.assignee === null ? 'jira-card-av none' : 'jira-card-av'} aria-hidden="true">
                {row.assignee === null ? '' : initialsOf(row.assignee.name)}
              </span>
              {live.has(row.key) && <RowSession state={live.get(row.key) as JiraSessionState} />}
              <Pill tone="neutral">{row.status.name}</Pill>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A Children row's session: the state's dot and word in a neutral pill, wrapped so the tree places it (`.jira-tree-session`) without restyling `Pill`. */
function RowSession({ state }: { state: JiraSessionState }) {
  return (
    <span className="jira-tree-session">
      <Pill tone="neutral" title={`a session is ${STATE_LABEL[state].toLowerCase()} on this ticket`}>
        <i className="ui-stripe-dot" data-tone={sessionTone(state)} aria-hidden="true" />
        {STATE_LABEL[state]}
      </Pill>
    </span>
  );
}

/**
 * The empty agent band's third line when a child has a live session (`underway[0]`, the deck's lead among the tree's rows): `<state> on <key>`, `+N more`
 * when others are live too. It opens that child the way its Children row does — the same `onOpenIssue` and the same snapshot — so a reader who came here from a
 * `Working` epic reaches the session in one press.
 */
function ChildSessionLine({ first, more, onOpen }: { first: DeckEntry; more: number; onOpen: () => void }) {
  return (
    <button type="button" className="jira-detail-agent-child" onClick={onOpen}>
      <i className="ui-stripe-dot" data-tone={sessionTone(first.state)} aria-hidden="true" />
      <span className="jira-detail-agent-child-text">{`${STATE_LABEL[first.state]} on ${first.issue.key} →`}</span>
      {more > 0 && <span className="jira-detail-agent-child-more">{`+${more} more`}</span>}
    </button>
  );
}

/**
 * The sub-task band's parent-live line (spec §4.3; DESIGN.md §8.9.2): `ChildSessionLine`'s skin — the lead session's tone dot, the words, `+N more` — pointed
 * UP at the parent, whose newest live session leads. A click opens the parent's Detail, as the head's parent link does.
 */
function ParentSessionLine({ parentKey, lead, more, onOpen }: { parentKey: string; lead: SessionLink; more: number; onOpen: () => void }) {
  return (
    <button type="button" className="jira-detail-agent-child jira-detail-parent-line" onClick={onOpen}>
      <i className="ui-stripe-dot" data-tone={sessionTone(lead.state)} aria-hidden="true" />
      <span className="jira-detail-agent-child-text">{parentLineText(parentKey, lead)}</span>
      {more > 0 && <span className="jira-detail-agent-child-more">{`+${more} more`}</span>}
    </button>
  );
}

/**
 * The Move-to popover's rows (`Modal.dc.html`, spec §4.4): one per offered transition in Jira's order, labelled by `transitionOptions` (the landing status, or the
 * transition's own name when two land together), each with a dot in the landing status's tone. Every row that lands on the CURRENT status is pinned first, in
 * Jira's order, with a tick and `aria-disabled` — a move to where the ticket already is would post a no-op — and the rest follow in Jira's order. The disabled rows
 * stay buttons, not `disabled` ones, so a screen reader still reads them; they just do nothing. Focus lands on the first row that DOES something when the panel
 * mounts, since it mounts only while open.
 */
function JiraMoveRows({ transitions, current, onPick }: { transitions: readonly JiraTransition[]; current: string; onPick: (id: string) => void }) {
  const labels = transitionOptions(transitions);
  const rows = transitions.map((t, i) => ({ t, label: labels[i].label, here: t.to.name === current }));
  const ordered = [...rows.filter((r) => r.here), ...rows.filter((r) => !r.here)];
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const firstEnabled = ordered.findIndex((r) => !r.here);
  return (
    <>
      <div className="jira-move-head">Move to</div>
      {ordered.map((r, i) => (
        <button
          key={r.t.id}
          ref={i === firstEnabled ? first : undefined}
          type="button"
          className="jira-move-row"
          aria-disabled={r.here ? true : undefined}
          onClick={() => !r.here && onPick(r.t.id)}
        >
          <span className="jira-status-dot" data-tone={statusTone(r.t.to.category)} aria-hidden="true" />
          <span className="jira-move-label">{r.label}</span>
          {r.here && <Glyph name="tick" size={14} />}
        </button>
      ))}
      <div className="jira-move-note">Jira transitions, applied on click</div>
    </>
  );
}
