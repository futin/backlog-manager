import { useLayoutEffect, useRef, useState } from 'react';

import { useJiraContext } from '../../hooks/JiraContext';
import { useAction } from '../../hooks/useAction';
import { useFetched } from '../../hooks/useFetched';
import { JIRA_COLUMNS, displayPath, initialsOf, issueDatesLine, modalTree, progressLine, type JiraChildrenIndex } from '../../lib/jira';
import { renderMarkdown } from '../../lib/markdown';
import type { JiraIssue, JiraIssueDetail, JiraTransition } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { Fact } from '../ui/Fact';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Modal } from '../ui/Modal';
import { Pill } from '../ui/Pill';
import { Select } from '../ui/Select';
import { SpreadBar } from '../ui/SpreadBar';

/**
 * JiraIssueModal — one Jira issue's detail, and since Jira phase 3 the board's two writes to Jira itself (spec §6.3 minus phase 5's `Run ▾` / `Stop
 * session`; DESIGN.md §8.9.2, which applies §8.7's sidecar to a Jira issue).
 *
 * **It is the item modal's twin, not a second modal design.** It composes `ui/Modal` exactly as `board/ItemModal.tsx` does — so the scrim, the close
 * control, the Escape key (the LIFO stack in `useDialogEscape`, called by the shell and never here) and the 700 px fold are the shell's — and draws the same
 * facts column through `ui/Fact` and the same body through `.item-body`. `Modal`'s composer list is `[ItemModal, JiraIssueModal]` and a third is a design
 * change.
 *
 * **The controls row** (Jira phase 3; spec §6.3, §8; DESIGN.md §8.9.2) sits under the facts list, inside the facts column, and holds two controls:
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
 * `Run ▾`, `Stop session` and the `session` fact are phase 5's and stay ABSENT, not drawn disabled: a disabled control is a promise a later phase has not
 * kept yet. `JiraIssueDetail.session` is still typed `null`, and so is unread.
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
 * reading the Setup card gives), or the hint that says where to map one. The `created · updated` line (`issueDatesLine`) takes `Date.now()` once per render and ticks nothing — the modal is
 * opened, read and closed, the reasoning `ItemModal` gives for the same choice.
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

/** The sentence a failed read or write carries: the server's `{ error }` when it sent one, else the HTTP status, else whatever the network said. */
async function failureOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    /* not JSON — fall through to the status */
  }
  return `HTTP ${res.status}`;
}

/**
 * The shape guard the detail is read through (`isJiraStatusPayload`'s role and reason): the three fields the body MAPS or READS without a null-safe
 * expression. A body missing one would throw inside a render and React would unmount the whole page under the modal, so it is a failed read instead.
 */
function isIssueDetail(value: unknown): value is JiraIssueDetail {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.description === 'string' && Array.isArray(d.children) && Array.isArray(d.boards);
}

/**
 * The `Move to…` options, each named by the STATUS it lands in — the word Jira's own status picker and columns show. A transition's own name is workflow
 * plumbing (`In Review (2)`, `In testing`), and printing both read `In Review (2) → In Review`. Only when two offered transitions land in one status do
 * those two fall back to their own names, because two options reading the same word would be a pick the reader cannot tell apart.
 */
function transitionOptions(transitions: readonly JiraTransition[]): { value: string; label: string }[] {
  const landings = new Map<string, number>();
  for (const t of transitions) landings.set(t.to.name, (landings.get(t.to.name) ?? 0) + 1);
  return transitions.map((t) => ({ value: t.id, label: (landings.get(t.to.name) ?? 0) > 1 ? t.name : t.to.name }));
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
  onClose
}: {
  issue: JiraIssue;
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  onWrote: () => void;
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
      fetch(`/api/jira/issue/${encodeURIComponent(issue.key)}`)
        .then(async (res): Promise<Held> => {
          if (!res.ok) return { failure: await failureOf(res) };
          const body: unknown = await res.json();
          return isIssueDetail(body) ? { detail: body } : { failure: 'malformed response' };
        })
        .catch((e: unknown): Held => ({ failure: e instanceof Error ? e.message : String(e) })),
    [issue.key, rev]
  );
  const landed = mine !== null && 'detail' in mine ? mine.detail : null;
  if (landed !== null && landed !== kept) setKept(landed);
  const detail = landed ?? (mine === null && kept !== null && kept.key === issue.key ? kept : null);
  const failure = mine !== null && 'failure' in mine ? mine.failure : null;
  // The detail's copy is the fresher one; the card's is what the column draws until it lands (or for good, when the read fails).
  const src: JiraIssue = detail ?? issue;

  const now = Date.now();
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
