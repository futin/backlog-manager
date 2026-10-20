import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useAction } from '../../hooks/useAction';
import { useAgents } from '../../hooks/useAgents';
import { useFetched } from '../../hooks/useFetched';
import { useNow } from '../../hooks/useNow';
import {
  JIRA_COLUMNS,
  displayPath,
  failureOf,
  fetchJiraDetail,
  fetchJiraWorktrees,
  initialsOf,
  issueDatesLine,
  modalTree,
  progressLine,
  removeCommand,
  repoBasename,
  stopJira,
  ticketWorktrees,
  transitionOptions,
  type JiraChildrenIndex
} from '../../lib/jira';
import { elapsedSince } from '../../lib/item-age';
import { renderMarkdown } from '../../lib/markdown';
import type { JiraAction, JiraIssue, JiraIssueDetail, JiraWorktree, JiraWorktreesPayload } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Confirm } from '../ui/Confirm';
import { Fact } from '../ui/Fact';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Modal } from '../ui/Modal';
import { Pill } from '../ui/Pill';
import { Select } from '../ui/Select';
import { SpreadBar } from '../ui/SpreadBar';
import { JiraRunMenu } from './JiraRunMenu';

/**
 * JiraIssueModal — one Jira issue's detail, the board's two writes to Jira itself (Jira phase 3) and its session controls (Jira phase 5) — spec §6.3, §7;
 * DESIGN.md §8.9.2, which applies §8.7's sidecar to a Jira issue.
 *
 * **It is the item modal's twin, not a second modal design.** It composes `ui/Modal` exactly as `board/ItemModal.tsx` does — so the scrim, the close
 * control, the Escape key (the LIFO stack in `useDialogEscape`, called by the shell and never here) and the 700 px fold are the shell's — and draws the same
 * facts column through `ui/Fact` and the same body through `.item-body`. `Modal`'s composer list is `[ItemModal, JiraIssueModal]` and a third is a design
 * change.
 *
 * **The controls row** (Jira phase 3; spec §6.3, §8; DESIGN.md §8.9.2) sits under the facts list, inside the facts column, and holds four controls — the two
 * writes to Jira below, then phase 5's `Run ▾` and `Stop session`:
 *
 * - **`Assign to me`**, a 28 px `Chip` → `POST /api/jira/issue/assign` `{ key }`. Disabled, with the reason as its title, while the shell's status knows
 *   no identity (`data.me` null — which also covers a boot `myself` that has not answered: the server would refuse with 503 `no identity` anyway, and
 *   §8's reason it must is that Jira reads `{ accountId: null }` as UNASSIGN) and while the issue is already the reader's own (`already assigned to you`).
 * - **`Move to…`**, the `Select` primitive → `POST /api/jira/issue/transition` `{ key, transitionId }`. Its first option is the placeholder `''`; then one
 *   per transition the detail offers, named by the status it lands in (`transitionOptions`: `to.name`, or the transition's own name only when two land
 *   in one status). A pick posts AT ONCE — a native select has no confirm step, and the select is controlled at `''`, so it reads `Move to…` again on the
 *   very next render. Disabled until the detail lands (the transitions are the detail's, and the card carries none), with `transitions unavailable` as the
 *   title once that read failed, and `no transitions offered` when Jira offers none.
 *
 * - **`Run ▾`** (`JiraRunMenu`, the card's own chip) → `onRun(issue, action)`; the launch sheet is hosted by `JiraView`, ABOVE this modal, so Escape closes the
 *   sheet alone and the modal under it on the next press. It reads the shell's status and draws its own disabled / dashed readings; it is never hidden.
 * - **`Stop session`**, a 28 px `Chip` → `ui/Confirm` → `POST /api/agents/jira-stop` `{ key }`, drawn ONLY while the dashboard has agents enabled AND the shell's
 *   status holds a CONFIRMED (not `starting`) entry for the key — a starting entry has no process to stop yet, and the server would 409 it. It rides the same
 *   `useAction` as the two writes above, so one guard and one error line serve all three; a landed stop reloads the status and nudges the board, and that
 *   reload is the strip going away (spec §11). `StopSession` is mounted only for a confirmed entry, which is also the only time `useAgents()` reads
 *   `/api/agents/status`: a key with no session never asks.
 *
 * **The Worktrees list** (Jira repo/branch, spec §5.5; DESIGN.md §8.9.2) sits under the body and above the comments note, independent of the detail read: the
 * trees come from `GET /api/jira/worktrees`, which this modal asks for itself — on open, and again when the key changes or a session on it starts or ends
 * (the moments a tree is made or becomes safe to remove) — and `ticketWorktrees` narrows to this key's. The main tree never gets a row. A failed read, or
 * no tree, draws no heading at all; the previous answer for the same key stays drawn while a re-read is out, so the list does not blink on a Stop. Each row's
 * `Remove` COPIES `removeCommand` — the board never writes git — and is disabled, titled `a session is running on <KEY>`, while the shell knows of one. That
 * check is the best the board can do: a session it did not start (Copy prompt, a terminal) is invisible to it, which the enabled title says in so many words.
 *
 * **The `session` fact** reads the shell's `live[key]` (`<name> · <repo basename> · <elapsed>`, `starting`, or `—`) rather than the detail's `session`, which
 * stays typed `null`: the status is already polled, one poll old at worst, and the detail read would add a second source for one fact. The elapsed reading
 * ticks with `useNow` — the card strip's own clock — so it keeps counting while the modal stays open.
 *
 * **One write at a time, stamped with its key.** Both controls fire through ONE `useAction`, so its ref guard (bug-19's layer 1, the reason DESIGN.md
 * §8.4.1 gives `RunControls`) holds across both: a double click on Assign, or a Move picked while Assign is out, sends nothing — two clicks inside one tick
 * both read a `disabled` that has not been painted yet, and only a ref sees the first. Both controls are disabled while a write is out, the rendering half
 * of that guard; and they stay disabled across a Children-row swap until it settles, because one modal sends one write (plan ruling R6 leaves the
 * serialisation to this modal). Each write carries the key it was sent for, and its settle compares that against the key the modal shows NOW (`keyRef`):
 * a refusal for an issue the reader has swapped away from is dropped (`onError` → `true`, "handled"), never drawn under another issue's title, and a
 * landed write's detail re-read is skipped for the same reason. The status reload and the board nudge are NOT skipped: the write happened, and both of
 * those describe the board, not the modal's issue.
 *
 * **A failure says why, in place.** The server's sentence (`{ error }`), else `HTTP <status>`, else the network's own message — `failureOf`'s rule, the
 * same one the read uses — in a `role="alert"` line under the row. The modal stays open: a refusal (`Jira refused: …`, `transition not offered`) is
 * something to read and maybe retry, not a reason to lose the place. The line clears when the next write leaves (`useAction` clears it) and when the key
 * changes (cleared during render, so the new issue's first frame never carries the old one's refusal).
 *
 * **A landed write re-reads three things** (spec §6.1; rulings R7, R8): the shell's status (`useJiraContext().reload()`), the board's list (`onWrote`,
 * which bumps `JiraView`'s nudge), and this modal's own detail. A 200 with `reread: false` is a success like any other: it says the SERVER's re-read
 * failed after the write stood, the next sweep catches its cache up, and an error here would invite a retry of a write that already happened (R1). The
 * detail re-read is a `rev` counter in `useFetched`'s deps — which answers `PENDING` on any dep change — so the last detail that landed for this SAME key
 * is held here and drawn while the re-read is out (R8): no `loading…` flash, and no controls blinking to disabled-for-no-detail and back.
 *
 * **Two sources, one column.** The card hands over the `JiraIssue` it was drawn from, and every fact the card already carries is drawn from it at once —
 * the modal opens with a full column rather than a spinner. The detail (`GET /api/jira/issue/:key`, read fresh on open) then supplies the three things a
 * card cannot: the description, the children, and the boards that hold the issue; it also replaces the card's copy, which may be one poll old. A failed read
 * leaves the card's facts exactly as they were and says so where the body would be, with the server's own sentence (`could not read the ticket — Jira
 * unreachable: timeout`), because a column that blanked on a Jira blip would take the readable half down with the unreadable one.
 *
 * **The browser never talks to Jira.** The one request is to `/api/jira/issue/…`; the link out is the issue's `url` as the SERVER built it, rendered as
 * given in a new tab with no referrer, and the description goes in through `renderMarkdown` — the sanitising renderer that drops raw HTML and refuses a
 * `javascript:` href (see its header), which matters more here than on a backlog item, because this text was typed by anyone with access to the Jira site.
 *
 * **State belongs to a key.** The held answer is stamped with the issue key it was read for, and only that key's answer is read: reopening the modal on
 * another issue while a read is in flight never paints the first issue's description under the second one's title, and a late answer for a key the modal
 * has left is dropped. Facts that come from the detail (`on boards`) are simply absent while the held answer is for another key — and also once it has landed, if none of the
 * boards it names is one the shell's status knows (a board deleted a moment ago): the spec lists the fact unconditionally, but a label with nothing under it is
 * the empty fact `Fact`'s own header says never to draw.
 *
 * Repositories are read from the shell's one status (`useJiraContext`): the mapped paths for the issue's PROJECT key through `displayPath` (the same `~`
 * reading the Setup card gives), or the hint that says where to map one. The `created · updated` line (`issueDatesLine`) and the session fact read the one `useNow` clock, a minute's tick.
 *
 * **Children are a tree, and a row swaps THIS modal's issue** (DESIGN.md §8.9.2; grouped-board spec §6). The detail's `children` are the direct children,
 * fresh; under each hang its descendants from `childrenOf`, the board's fold index as it stood when the card was clicked (`modalTree`). That snapshot is not
 * refreshed by later board polls: the tree costs no Jira call beyond the one read this modal already makes, and a row a poll moved is at worst one poll old
 * while the direct children never are. `null` (no board behind the modal) draws the direct children only. The head row counts the DIRECT children in its
 * pill and says `N in all` only when the tree draws more rows than that; the spread bar counts the rows as drawn. No filter marking inside the tree — the
 * filter ring is the card's (spec §8 non-goal). A row click hands the row's issue and the SAME snapshot to `onOpenIssue`, which is the very setter the board
 * calls, so `JiraView` swaps the one modal's issue and the keyed read below fetches the new detail. Never a second `Modal`: Escape has one owner, and a
 * stack of issue modals would make it close one layer of a walk the reader thinks of as one dialog.
 */

type Held = { detail: JiraIssueDetail } | { failure: string };

/** What a status category reads as in a fact — `JIRA_COLUMNS`' own labels, lower-cased, so the column and the modal never name one category two ways. */
function categoryWord(category: JiraIssue['status']['category']): string {
  return (JIRA_COLUMNS.find((c) => c.category === category)?.label ?? 'To Do').toLowerCase();
}

/**
 * POSTs one issue write and resolves when it LANDED. A non-OK answer rejects with `failureOf`'s sentence, and a dropped request rejects with the
 * network's own error, so `useAction`'s `errorMessage` renders exactly the three readings the header names. The 200's body (`JiraIssueWriteResult`) is
 * not read: `reread` changes nothing here (see the header), and a body that failed to parse after a 200 must not turn a write that stood into an error.
 */
async function postWrite(path: 'assign' | 'transition', body: Record<string, string>): Promise<void> {
  const res = await fetch(`/api/jira/issue/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await failureOf(res));
}

export function JiraIssueModal({
  issue,
  childrenOf,
  onOpenIssue,
  onWrote,
  onRun,
  onClose
}: {
  issue: JiraIssue;
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  onWrote: () => void;
  /** `Run ▾`'s pick — the page opens the launch sheet over this modal. */
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  onClose: () => void;
}) {
  const { data, reload } = useJiraContext();
  const { busy, error: writeError, run, clearError } = useAction();
  // The key the modal shows NOW, read by a write's settle (see the header) — a ref, because the settle closure was made on the render that sent it.
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
  if (shownKey !== issue.key) {
    setShownKey(issue.key);
    clearError();
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
  // The Worktrees list's read: keyed on the issue and on WHETHER a session is live on it (not on the session object, which a status poll replaces).
  const sessionLive = data?.live[issue.key] !== undefined;
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

  // `useNow`, like the card strip's: the session fact's elapsed reading (and `created · updated`) ticks while the modal sits open between status polls.
  const now = useNow(true);
  const boardNames = detail === null || data === null ? [] : data.boards.filter((b) => detail.boards.includes(b.id)).map((b) => b.name);
  const paths = data?.repos[src.project.key] ?? [];
  const typeLine = [src.type.name, src.parent === null ? null : `${src.parent.key} ${src.parent.summary}`].filter((p) => p !== null).join(' · ');
  const priorityLine = [src.priority, src.sprint].filter((p) => p !== null && p !== '').join(' · ');
  const people = `${src.assignee === null ? 'unassigned' : src.assignee.name}${src.reporter === null ? '' : ` · ${src.reporter}`}`;

  const me = data?.me ?? null;
  const assignBlock = me === null ? 'no identity' : src.assignee?.accountId === me.accountId ? 'already assigned to you' : null;
  const moveBlock = failure !== null ? 'transitions unavailable' : detail !== null && detail.transitions.length === 0 ? 'no transitions offered' : null;
  const moveReady = detail !== null && detail.transitions.length > 0;

  /** The one write path both controls take (see the header): one guard, one error line, one key stamp. */
  const write = (path: 'assign' | 'transition', body: Record<string, string>): void => {
    const asked = issue.key;
    run(() => postWrite(path, body), {
      onSuccess: () => {
        reload();
        onWrote();
        if (keyRef.current === asked) setRev((r) => r + 1);
      },
      // `true` is "handled — draw nothing": the refusal is for an issue this modal no longer shows.
      onError: () => keyRef.current !== asked
    });
  };

  /** Stop, through the one write guard and error line (see the header); a landed stop reloads the status — the strip's way out — and nudges the board. */
  const stop = (): void => {
    const asked = issue.key;
    run(() => stopJira(asked), {
      onSuccess: () => {
        reload();
        onWrote();
      },
      onError: () => keyRef.current !== asked
    });
  };
  const live = data?.live[issue.key] ?? null;
  const sessionLine =
    live === null
      ? '—'
      : live.starting
        ? 'starting'
        : [live.name, repoBasename(live.repo), elapsedSince(live.startedAt, now)].filter((p) => p !== null).join(' · ');

  const facts = (
    <div className="item-facts">
      <div className="jira-modal-key">
        <span className="jira-modal-keyname">{src.key}</span>
        <a href={src.url} target="_blank" rel="noreferrer">
          open in Jira ↗
        </a>
      </div>
      <dl className="item-facts-list">
        <Fact label="type · parent">{typeLine}</Fact>
        <Fact label="status">{`${src.status.name} · ${categoryWord(src.status.category)}`}</Fact>
        {priorityLine !== '' && <Fact label="priority · sprint">{priorityLine}</Fact>}
        <Fact label="assignee · reporter">{people}</Fact>
        {src.labels.length > 0 && <Fact label="labels">{src.labels.join(', ')}</Fact>}
        <Fact label="created · updated">{issueDatesLine(src, now)}</Fact>
        {boardNames.length > 0 && <Fact label="on boards">{boardNames.join(', ')}</Fact>}
        <Fact label="repository">
          {data === null || paths.length === 0 ? (
            `no repository mapped for ${src.project.key} — Jira › Setup › Repositories`
          ) : (
            <span className="item-facts-path">{paths.map((p) => displayPath(p, data.home)).join(', ')}</span>
          )}
        </Fact>
        <Fact label="session">{sessionLine}</Fact>
      </dl>
      <div className="jira-modal-controls">
        <Chip size={28} disabled={busy || assignBlock !== null} title={assignBlock ?? undefined} onClick={() => write('assign', { key: issue.key })}>
          Assign to me
        </Chip>
        <Select
          label="Move to"
          title={moveBlock ?? undefined}
          value=""
          disabled={busy || !moveReady}
          options={[{ value: '', label: 'Move to…' }, ...transitionOptions(detail?.transitions ?? [])]}
          onChange={(id) => id !== '' && write('transition', { key: issue.key, transitionId: id })}
        />
        <JiraRunMenu issue={issue} home="modal" onPick={(action) => onRun(issue, action)} />
        {live !== null && !live.starting && <StopSession key={issue.key} busy={busy} onStop={stop} />}
      </div>
      {writeError !== null && (
        <p className="jira-modal-error" role="alert">
          {writeError}
        </p>
      )}
    </div>
  );

  return (
    <Modal label={`${src.key} ${src.summary}`} facts={facts} onClose={onClose}>
      <h2 className="item-body-title">{src.summary}</h2>
      <div className="item-body">
        {failure !== null ? (
          <div className="drawer-empty">{`could not read the ticket — ${failure}`}</div>
        ) : detail === null ? (
          <div className="drawer-empty">loading…</div>
        ) : (
          <>
            {detail.description.trim() === '' ? (
              <p className="jira-modal-none">no description</p>
            ) : (
              // Keyed on the issue, so a Children-row swap opens the next description collapsed rather than inheriting this one's `Show more`.
              <Description key={detail.key} markdown={detail.description} />
            )}
            {detail.children.length > 0 && <ChildrenTree selfKey={detail.key} direct={detail.children} childrenOf={childrenOf} onOpenIssue={onOpenIssue} />}
          </>
        )}
        {ticketTrees.length > 0 && <WorktreesList trees={ticketTrees} issueKey={issue.key} live={live !== null} home={data?.home ?? null} />}
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
 * The ticket's worktrees (header, "The Worktrees list"): one row per tree — branch, path and repo through `displayPath` — and a `Remove` that copies the
 * command and runs nothing. The button reads `Copied` for 2 s; with no clipboard API, or a refused write, the command itself is drawn under the row so it can
 * be selected by hand. It is disabled while `live` — the shell knows of a session on this key — and its title then names the key.
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
          <WorktreeRow key={t.path} tree={t} issueKey={issueKey} live={live} home={home} />
        ))}
      </ul>
    </section>
  );
}

const REMOVE_TITLE =
  'Copies the command. Sessions the board did not start — Copy prompt, a terminal — cannot be seen: make sure none is using this tree.';

function WorktreeRow({ tree, issueKey, live, home }: { tree: JiraWorktree; issueKey: string; live: boolean; home: string | null }) {
  const command = removeCommand(tree);
  const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function';
  const [copied, setCopied] = useState(false);
  const [refused, setRefused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  const copy = (): void => {
    if (!canCopy) {
      setRefused(true);
      return;
    }
    navigator.clipboard.writeText(command).then(
      () => {
        setRefused(false);
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => setRefused(true)
    );
  };
  const branch = tree.branch ?? 'detached';
  return (
    <li className="jira-wt-row">
      <span className="jira-wt-branch">{branch}</span>
      <span className="jira-wt-path" title={tree.path}>
        {displayPath(tree.path, home)}
      </span>
      <span className="jira-wt-repo" title={tree.repo}>
        {displayPath(tree.repo, home)}
      </span>
      <Chip
        size={28}
        disabled={live}
        title={live ? `a session is running on ${issueKey}` : REMOVE_TITLE}
        aria-label={`Remove worktree ${branch}`}
        onClick={copy}
      >
        {copied ? 'Copied' : 'Remove'}
      </Chip>
      {refused && <code className="jira-wt-cmd">{command}</code>}
    </li>
  );
}

/**
 * `Stop session` and its confirmation (Jira phase 5, spec §7; DESIGN.md §8.9.2). Mounted by the modal only for a confirmed live entry, so `useAgents()` — the
 * dashboard's `enabled` flag, the same gate the card's dispatch control reads — asks `/api/agents/status` only then. Nothing is drawn with agents off or
 * before the answer lands: a Stop the dashboard would refuse is a promise it cannot keep. The question REPLACES the chip in place (`ui/Confirm`, the claim
 * release's precedent), and the safe answer holds the focus. The POST itself is the modal's, so its refusal draws in the modal's one alert line.
 */
function StopSession({ busy, onStop }: { busy: boolean; onStop: () => void }) {
  const { status } = useAgents();
  const [asking, setAsking] = useState(false);
  if (status === null || !status.enabled) return null;
  if (!asking)
    return (
      <Chip size={28} disabled={busy} title="end the session running on this issue" onClick={() => setAsking(true)}>
        Stop session
      </Chip>
    );
  return (
    <Confirm
      label="confirm stop"
      testId="jira-stop-confirm"
      acceptLabel="Stop session"
      dismissLabel="Keep running"
      onDismiss={() => setAsking(false)}
      onAccept={() => {
        setAsking(false);
        onStop();
      }}
    >
      Stop this session? It ends mid-work; its edits stay where it left them.
    </Confirm>
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

/** The Children section — head row, spread bar, tree — over `modalTree` (see the header). Drawn only when the detail has direct children. */
function ChildrenTree({
  selfKey,
  direct,
  childrenOf,
  onOpenIssue
}: {
  selfKey: string;
  direct: readonly JiraIssue[];
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
}) {
  const { rows, progress } = modalTree(selfKey, direct, childrenOf);
  return (
    <>
      <div className="jira-tree-head">
        <h3>Children</h3>
        <Pill tone="neutral">{direct.length}</Pill>
        {rows.length > direct.length && <span className="jira-tree-all">{`${rows.length} in all`}</span>}
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
              <Pill tone="neutral">{row.status.name}</Pill>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
