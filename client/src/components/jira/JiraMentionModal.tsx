import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';

import {
  JIRA_REPLY_MAX_CHARS,
  type JiraIssueDetail,
  type JiraMention,
  type JiraMentionDraft,
  type JiraMentionIssue,
  type JiraSessionsPayload,
  type JiraThreadComment,
  type JiraThreadPayload
} from '../../../../shared/types';
import { useFetched } from '../../hooks/useFetched';
import type { JiraMentionsWrite, JiraReplyWrite } from '../../hooks/useJiraMentions';
import { useMountedRef } from '../../hooks/useMountedRef';
import { useNarrow } from '../../hooks/useNarrow';
import { elapsedSince } from '../../lib/item-age';
import { fetchJiraDetail, initialsOf, repoBasename, statusTone, typeTone } from '../../lib/jira';
import { askedAge, chipMentions, draftState, fetchJiraThread, mentionIssueType, replyMarkdown, replyTo, threadFold } from '../../lib/jira-mentions';
import { openButtons } from '../../lib/jira-sessions';
import { renderMarkdown } from '../../lib/markdown';
import { Chevron } from '../ui/Chevron';
import { Chip } from '../ui/Chip';
import { Fact } from '../ui/Fact';
import { Glyph } from '../ui/Glyphs';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { OpenChip } from './SessionOpen';

/** Where the opened ticket stands in the page's latest answer: still waiting, dismissed, or gone from both (answered, or aged out of the window). */
export type MentionTicketState = 'open' | 'dismissed' | 'gone';

/** A sessions-context link as `/api/jira/sessions` answers it: the link plus its dashboard state, row and since-stamp. */
export type MentionSessionLink = JiraSessionsPayload['links'][number];

/** The reply this dialog posted, held until the walk leaves the ticket: what the thread appends and the posted line links. */
interface PostedReply {
  id: string;
  url: string;
  to: string | null;
  text: string;
  at: string;
}

/**
 * DESIGN.md §8.9.7 — the mention modal, thread first (Jira mentions phase 1, Task 10; spec "The mention modal"; mock `ModalA.dc.html`), and since phase 2
 * (Task 8, mock `ModalDraft.dc.html`) the place a reply is drafted, edited and posted — see **Draft a reply** below.
 *
 * **`Modal`'s split shape, thread on the left.** The head is the Detail dialog's (`.jira-detail-head`: type tile, key, type, project, the board badge, the
 * title as an `h2`) with the walk's `Mention i of N` and its two arrows where Detail has its link out. The facts slot — the LEFT column, and the one that
 * folds FIRST under 700 px — holds the thread and its footer, because the thread is what the reader came for; the body holds the ticket's facts. The mock
 * gives the thread 1.6 of 2.6 of the width, so the shell is asked for its `lead` weighting rather than Detail's near-even split.
 *
 * **Two reads, each once per ticket.** `GET /api/jira/issue/:key/thread` and `GET /api/jira/issue/:key`, through `useFetched` keyed on the KEY alone: a step
 * to another mention on the same ticket only moves the focus (`data-focused`, scrolled into view) and reads nothing, a step to another ticket reads both
 * again. Neither is cached past the modal — the thread is the point and must be current. A thread the server refuses (`SUP-208 is not readable`) prints the
 * server's own sentence in the thread column, and the dialog stays open on the header the page already knew.
 *
 * **The thread.** `Comments · <total>` (the server's count, which a truncated thread exceeds), oldest first; the comments before the user's own latest one
 * fold under `Show N earlier comments` (`threadFold`) unless the focused mention is among them. An `open` comment — it mentions the user and nothing of theirs
 * answers it — carries the amber `Asks you · <age>` strip while the ticket is not dismissed; the user's own are labelled `You`. Text goes through
 * `renderMarkdown`, the one sanitising renderer the Detail dialog's description uses, then `chipMentions` tints every `@Name` of the user or a thread author.
 * Authors are initials discs, never the avatar: §8.9's standing rule is that the browser never talks to Jira.
 *
 * **The footer is the ticket's state, read from the page's answer** (`state`), never guessed here. Open: `You have not commented since this mention.`,
 * `Dismiss` (every open mention on the ticket, the user answers a thread) and `Reply in Jira` (the ink chip, the focused-comment `url`). Dismissed FROM this
 * dialog: the green `Dismissed. It comes back …` line with `Undo`, which restores. Opened already dismissed (Show dismissed on): `Restore` and `Open in Jira`.
 * Gone: only the link. Writes are the page's hook's — they never reject, a refusal lands in the band — and each resolves its outcome, because that band is
 * under the scrim: a refusal (`<id> is not an open mention on <KEY>` whenever the page's data is one poll stale) is drawn here as a `role="alert"` line
 * under the footer, the Detail dialog's write-error shape, and an optimistic `dismissedHere` is taken back, so the footer is the one the ticket still has.
 * `busy` keeps a double click from posting twice, and a write's outcome lands only while its own ticket is still the one shown.
 *
 * **Every link out is a server-built `url`** (the mention's focused-comment link, the detail's ticket link), opened by `Chip as="a"` in a new tab with no
 * referrer.
 *
 * **Draft a reply (phase 2).** Only an OPEN ticket drafts — a dismissed one shows none of this until it is restored, because a reply to a thread the reader
 * set aside is not what Restore promises. The state is `draftState(issue)`, read from the page's answer on every render, never kept here:
 * - `idle` — the open footer gains `Draft a reply` (outline, between Dismiss and Reply in Jira), and the ticket column a **Draft session** pane: the repo
 *   the session will read (`replyRepos`, the ticket project's own first, the page computes it), `· read only`, and the sentence that it never posts. No repo
 *   mapped anywhere disables the chip with its reason as the title. The click is `onDraft(repo)` — the page's `dispatchReply` — `busy` while it is out, and a
 *   refusal (409: one reply per key) is the same `role="alert"` line every write here uses.
 * - `drafting` — the footer is the run card: `Drafting a reply`, the elapsed time from `session.startedAt`, **Open session** and **Stop**. Open session is
 *   `OpenChip` over `openButtons`' primary decision (Dashboard, desktop or remote) relabelled, and stays a disabled chip until the sessions context carries
 *   the `(key, sessionId)` link; Stop waits for a `sessionId` (the spawn has not reported one yet) and asks no confirmation — the session is read-only, so
 *   stopping it loses nothing a person wrote.
 * - `ready` — the draft box (`DraftReply`, keyed on the ticket): `Your reply`, its age, a fixed `To @<name>` line (`replyTo`: the server prepends that mention
 *   itself, so the textarea holds the text only, and a newer mention by someone else re-addresses it on the next render), the textarea, the counter against
 *   `JIRA_REPLY_MAX_CHARS`, the sentence saying where it posts, and Redraft / Discard / Post reply. While the draft's own session is still live (the minutes
 *   before its link ends) Open session and Stop ride in the box head, and Redraft is disabled: the server allows one reply session per key.
 * - `replacing` — a newer session is drafting over an older draft: the run card above the old draft, which says it is being replaced and stays postable.
 * - **posted** (local, dropped by a step to another ticket) — the reply joins the thread as `You · just now`, and the footer says it left the list with
 *   `View in Jira` (the server's `posted.url`) and, when there is one, `Next mention` (the header arrow's step). The ticket is `gone` from the answer by then,
 *   so the posted line wins over the gone footer.
 * The page's hook re-reads every `JIRA_REPLY_REREAD_MS` while any ticket has a session (`useJiraMentions`), which is what moves these states; nothing here
 * polls.
 */
export function JiraMentionModal({
  issue,
  mention,
  state,
  me,
  now,
  position,
  onPrev,
  onNext,
  onDismiss,
  onRestore,
  repos,
  sessionLink,
  onDraft,
  onStop,
  onDiscard,
  onPost,
  onHandover,
  onClose
}: {
  issue: JiraMentionIssue;
  /** The mention this stop of the walk is on: its comment is focused, and its `url` is the reply link. */
  mention: JiraMention;
  state: MentionTicketState;
  /** The user's Jira display name — one of the names `@` chips are drawn for. */
  me: string | null;
  now: number;
  /** `Mention i of N`, or `null` while this mention has left the page's visible order (the dialog keeps showing it; see `JiraMentionsView`). */
  position: { at: number; of: number } | null;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onDismiss: () => Promise<JiraMentionsWrite>;
  onRestore: () => Promise<JiraMentionsWrite>;
  /** The repos a drafting session may read, best first (`replyRepos`); empty disables Draft a reply. */
  repos: readonly string[];
  /** The sessions context's link for `issue.session`, matched by `(key, sessionId)` — `null` until the sessions poll has seen it. */
  sessionLink: MentionSessionLink | null;
  onDraft: (repo: string) => Promise<JiraMentionsWrite>;
  onStop: (sessionId: string) => Promise<JiraMentionsWrite>;
  onDiscard: () => Promise<JiraMentionsWrite>;
  onPost: (text: string) => Promise<JiraReplyWrite>;
  /** The dashboard's hand-over to the Desktop app; its outcome goes through `write`, so a refusal is this dialog's alert line like any other write's. */
  onHandover: (sessionId: string) => Promise<JiraMentionsWrite>;
  onClose: () => void;
}) {
  const mounted = useMountedRef();
  const thread = useFetched(() => fetchJiraThread(issue.key), [issue.key]);
  const detail = useFetched(() => fetchJiraDetail(issue.key), [issue.key]);
  // `dismissedHere` tells the two dismissed footers apart (the Undo line after this dialog's own Dismiss, Restore for a ticket opened dismissed); both it
  // and `busy` belong to ONE ticket, so a step to another drops them on the render that carries the new key, the shownKey pattern `JiraDetail` uses.
  const [shownKey, setShownKey] = useState(issue.key);
  const [dismissedHere, setDismissedHere] = useState(false);
  const [busy, setBusy] = useState(false);
  // The last write's refusal, the server's own sentence; cleared by the next write and by a step to another ticket.
  const [refused, setRefused] = useState<string | null>(null);
  // The reply this dialog posted on the shown ticket, and the repo picked for the next draft — both one ticket's, so both go with the shownKey reset.
  const [posted, setPosted] = useState<PostedReply | null>(null);
  const [pickedRepo, setPickedRepo] = useState<string | null>(null);
  if (shownKey !== issue.key) {
    setShownKey(issue.key);
    setDismissedHere(false);
    setBusy(false);
    setRefused(null);
    setPosted(null);
    setPickedRepo(null);
  }
  // The key the dialog shows NOW and the newest write's number, both read by a write's settle — refs, because the settle closure was made on the render that
  // sent it (`JiraDetail`'s `keyRef`). A write belongs to the ticket it was made on: Dismiss on A, Next to B before the post answers, and A's outcome must not
  // run `setBusy(false)` on B (re-enabling B's Dismiss while B's own write is out, which is the double click `busy` exists to stop), nor draw A's refusal
  // (`<id> is not an open mention on A`) as B's alert, nor put A's `before` back as B's `dismissedHere`. The number covers the walk back (A → B → A): a
  // second write on A supersedes the first, so only the newest settle may clear `busy`.
  const keyRef = useRef(issue.key);
  keyRef.current = issue.key;
  const writeSeq = useRef(0);

  // `here` is the `dismissedHere` the write means to leave behind (a draft write leaves it as it is); set before the post so the footer answers the click at
  // once, and put back on a refusal. `onOk` runs on the ticket's own success only — the posted state is drawn from it.
  const write = <W extends JiraMentionsWrite>(run: () => Promise<W>, opts: { here?: boolean; onOk?: (outcome: W) => void } = {}): void => {
    const before = dismissedHere;
    const key = issue.key;
    const seq = ++writeSeq.current;
    setBusy(true);
    setRefused(null);
    if (opts.here !== undefined) setDismissedHere(opts.here);
    void run().then((outcome) => {
      if (!mounted.current || keyRef.current !== key || writeSeq.current !== seq) return;
      setBusy(false);
      if (!outcome.ok) {
        setRefused(outcome.message);
        setDismissedHere(before);
      } else opts.onOk?.(outcome);
    });
  };

  const type = mentionIssueType(issue.type);
  const noBoard = issue.boards.length === 0;
  const project = detail.status === 'ok' && detail.value !== null ? detail.value.project.name : null;

  const head = (
    <div className="jira-detail-head">
      <div className="jira-detail-crumbs">
        <span className="jira-card-type" data-tone={typeTone(type)} title={issue.type}>
          <JiraTypeIcon type={type} />
        </span>
        <span className="jira-detail-key">{issue.key}</span>
        {issue.type !== '' && <span>{`· ${issue.type}`}</span>}
        {project !== null && project !== '' && <span>{`· ${project}`}</span>}
        {noBoard && <span>· on none of your boards</span>}
      </div>
      <span className="jira-mention-nav">
        {position !== null && <span className="jira-mention-pos">{`Mention ${position.at} of ${position.of}`}</span>}
        <Chip size={28} icon={<Chevron dir="left" />} aria-label="Previous mention" disabled={onPrev === null} onClick={onPrev ?? undefined}>
          {null}
        </Chip>
        <Chip size={28} icon={<Chevron dir="right" />} aria-label="Next mention" disabled={onNext === null} onClick={onNext ?? undefined}>
          {null}
        </Chip>
      </span>
      <h2 className="jira-detail-title">{issue.summary}</h2>
    </div>
  );

  const asking = state !== 'dismissed';
  const drafts = state === 'open' && posted === null;
  const phase = draftState(issue);
  const to = replyTo(issue);
  const repo = pickedRepo !== null && repos.includes(pickedRepo) ? pickedRepo : (repos[0] ?? null);
  const session = issue.session;
  const sessionId = session?.sessionId ?? null;
  const sessionActs =
    session === null ? null : (
      <>
        <SessionChip link={sessionLink} sessionId={sessionId} onHandover={(id) => write(() => onHandover(id))} />
        <Chip size={28} disabled={busy || sessionId === null} onClick={sessionId === null ? undefined : () => write(() => onStop(sessionId))}>
          Stop
        </Chip>
      </>
    );
  const runCard =
    session === null ? null : (
      <div className="jira-reply-run">
        <span className="jira-reply-run-dot" aria-hidden="true" />
        <span className="jira-reply-run-what">
          <span className="jira-reply-run-title">Drafting a reply</span>
          {elapsedSince(session.startedAt, now) !== null && <span className="jira-reply-run-sub">{elapsedSince(session.startedAt, now)}</span>}
        </span>
        <span className="jira-mention-foot-acts">{sessionActs}</span>
      </div>
    );
  const draftBox = (draft: JiraMentionDraft) => (
    <DraftReply
      key={issue.key}
      issueKey={issue.key}
      draft={draft}
      to={to?.name ?? null}
      now={now}
      busy={busy}
      replacing={phase === 'replacing'}
      // Its own session still live: the box head carries the run's controls (in `replacing` the run card above has them).
      headActs={phase === 'ready' ? sessionActs : null}
      redraftBlocked={session !== null}
      onRedraft={() => {
        if (repo !== null) write(() => onDraft(repo));
      }}
      canRedraft={repo !== null}
      onDiscard={() => write(onDiscard)}
      onPost={(text) =>
        write(() => onPost(text), {
          onOk: (outcome) => {
            if (outcome.posted !== undefined) setPosted({ ...outcome.posted, to: to?.name ?? null, text, at: new Date(now).toISOString() });
          }
        })
      }
    />
  );
  const mine: JiraThreadComment | null =
    posted === null
      ? null
      : {
          id: posted.id,
          author: { accountId: '', name: me ?? 'You' },
          created: posted.at,
          markdown: replyMarkdown(posted.to, posted.text),
          mine: true,
          mentionsMe: false,
          open: false
        };
  const left = (
    <div className="jira-detail-agent">
      {thread.status === 'failed' ? (
        <p className="jira-modal-error" role="alert">
          {thread.error instanceof Error ? thread.error.message : String(thread.error)}
        </p>
      ) : thread.status !== 'ok' || thread.value === null ? (
        <div className="drawer-empty">loading…</div>
      ) : (
        // Keyed on the ticket: `Show N earlier comments` is one thread's choice, and the next ticket opens folded.
        <Thread key={issue.key} thread={thread.value} focus={mention.commentId} asking={asking} me={me} now={now} posted={mine} />
      )}
      {posted !== null ? (
        <div className="jira-mention-done jira-reply-posted">
          <span>{`Posted to ${issue.key}. The mention left your list.`}</span>
          <span className="jira-mention-foot-acts">
            <Chip size={28} as="a" href={posted.url} icon={<Glyph name="external" />}>
              View in Jira
            </Chip>
            {onNext !== null && (
              <Chip size={28} onClick={onNext}>
                Next mention
              </Chip>
            )}
          </span>
        </div>
      ) : drafts && phase === 'drafting' ? (
        runCard
      ) : drafts && issue.draft !== null && (phase === 'ready' || phase === 'replacing') ? (
        <>
          {phase === 'replacing' && runCard}
          {draftBox(issue.draft)}
        </>
      ) : state === 'open' ? (
        <div className="jira-mention-foot">
          <span>You have not commented since this mention.</span>
          <span className="jira-mention-foot-acts">
            <Chip disabled={busy} onClick={() => write(onDismiss, { here: true })}>
              Dismiss
            </Chip>
            <Chip
              disabled={busy || repo === null}
              title={repo === null ? 'Map a repository in Jira › Setup first' : undefined}
              onClick={repo === null ? undefined : () => write(() => onDraft(repo))}
            >
              Draft a reply
            </Chip>
            <Chip variant="ink" as="a" href={mention.url} icon={<Glyph name="external" />}>
              Reply in Jira
            </Chip>
          </span>
        </div>
      ) : state === 'dismissed' && dismissedHere ? (
        <div className="jira-mention-done">
          <span>{`Dismissed. It comes back if someone mentions you on ${issue.key} again.`}</span>
          <Chip size={28} disabled={busy} onClick={() => write(onRestore, { here: false })}>
            Undo
          </Chip>
        </div>
      ) : (
        <div className="jira-mention-foot">
          <span className="jira-mention-foot-acts">
            {state === 'dismissed' && (
              <Chip disabled={busy} onClick={() => write(onRestore, { here: false })}>
                Restore
              </Chip>
            )}
            <Chip as="a" href={mention.url} icon={<Glyph name="external" />}>
              Open in Jira
            </Chip>
          </span>
        </div>
      )}
      {refused !== null && (
        <p className="jira-modal-error" role="alert">
          {refused}
        </p>
      )}
    </div>
  );

  return (
    <Modal label={`${issue.key} mention`} head={head} facts={left} lead onClose={onClose}>
      <div className="jira-detail-ticket">
        <div className="jira-detail-lbl">Ticket</div>
        <div className="jira-detail-pane">
          {detail.status === 'failed' ? (
            <div className="drawer-empty">{`could not read the ticket — ${detail.error instanceof Error ? detail.error.message : String(detail.error)}`}</div>
          ) : detail.status !== 'ok' || detail.value === null ? (
            <div className="drawer-empty">loading…</div>
          ) : (
            <TicketFacts detail={detail.value} now={now} />
          )}
        </div>
        {noBoard && <div className="jira-mention-note">This ticket is on none of your boards, so the board cannot open it.</div>}
        {drafts && (
          <>
            <div className="jira-detail-lbl">Draft session</div>
            <div className="jira-detail-pane jira-reply-session">
              <span className="jira-reply-repo">
                <span className="jira-reply-repo-lbl">Repo</span>
                {session !== null ? (
                  <span className="jira-reply-repo-name">{repoBasename(session.repo)}</span>
                ) : repos.length > 0 && repo !== null ? (
                  <Select<string>
                    label="Repository"
                    value={repo}
                    options={repos.map((r) => ({ value: r, label: repoBasename(r) }))}
                    onChange={setPickedRepo}
                    disabled={busy}
                  />
                ) : (
                  <span>no repository mapped</span>
                )}
                <span>· read only</span>
              </span>
              <p className="jira-reply-session-note">
                The session reads the thread, the ticket and the code, and writes a draft here. It never posts; Post reply does.
              </p>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The ticket column's pane: the mock's six facts, the description's first lines, and the link to the ticket. */
function TicketFacts({ detail, now }: { detail: JiraIssueDetail; now: number }) {
  const updated = askedAge(detail.updated, now);
  return (
    <div className="jira-mention-ticket">
      <dl className="jira-detail-facts">
        <Fact label="Status" icon={<Glyph name="ring" />}>
          <span className="jira-status-dot" data-tone={statusTone(detail.status.category)} aria-hidden="true" />
          {detail.status.name}
        </Fact>
        <Fact label="Assignee" icon={<Glyph name="person" />}>
          {detail.assignee === null ? 'unassigned' : detail.assignee.name}
        </Fact>
        {detail.reporter !== null && (
          <Fact label="Reporter" icon={<Glyph name="person" />}>
            {detail.reporter}
          </Fact>
        )}
        {detail.priority !== null && detail.priority !== '' && (
          <Fact label="Priority" icon={<Glyph name="flag" />}>
            {detail.priority}
          </Fact>
        )}
        {detail.parent !== null && (
          <Fact label="Parent" icon={<Glyph name="branch" />}>
            {`${detail.parent.key} ${detail.parent.summary}`}
          </Fact>
        )}
        {updated !== null && (
          <Fact label="Updated" icon={<Glyph name="calendar" />}>
            {updated}
          </Fact>
        )}
      </dl>
      {/* The first lines only (`.jira-mention-desc`'s clamp): the whole description is one click away in Jira, and the thread is this dialog's point. */}
      {detail.description.trim() !== '' && <div className="jira-mention-desc" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.description) }} />}
      <span>
        <Chip size={28} as="a" href={detail.url} icon={<Glyph name="external" />}>
          Open ticket in Jira
        </Chip>
      </span>
    </div>
  );
}

/**
 * The thread column. The fold opens by itself when the focused mention sits inside it, so a step never lands on a comment the reader cannot see, and the
 * focused comment is scrolled to (`block: 'nearest'`, so a comment already in view does not jump).
 *
 * The route returns the newest `JIRA_THREAD_MAX` comments, so on a long thread the focused mention can be older than all of them (`truncated`, and its id is
 * not among them): nothing can be highlighted or scrolled to, and the fold stays closed. Rather than leave the reader looking for it, a muted line at the top
 * of the thread says so — the footer's Jira link (the mention's focused-comment `url`) is the way to it. Only on a truncated thread: a missing id on a whole
 * thread means the comment was deleted since the last check, which the next check settles, and a line there would be a guess.
 */
function Thread({
  thread,
  focus,
  asking,
  me,
  now,
  posted
}: {
  thread: JiraThreadPayload;
  focus: string;
  asking: boolean;
  me: string | null;
  now: number;
  /** The reply this dialog just posted, drawn after the thread: the thread read is the one taken on open, and a re-read only to show it is a wasted call. */
  posted: JiraThreadComment | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const focused = useRef<HTMLDivElement>(null);
  const { comments } = thread;
  const fold = threadFold(comments);
  const focusAt = comments.findIndex((c) => c.id === focus);
  const open = expanded || (focusAt !== -1 && focusAt < fold);
  const shown = open ? comments : comments.slice(fold);
  const names = [...(me === null ? [] : [me]), ...comments.map((c) => c.author.name)];

  useEffect(() => {
    focused.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focus]);

  return (
    <>
      <div className="jira-detail-lbl">{`Comments · ${thread.total}`}</div>
      <div className="jira-mention-thread">
        {focusAt === -1 && thread.truncated && (
          <p className="jira-detail-none">{`This mention is older than the ${comments.length} newest comment${comments.length === 1 ? '' : 's'} loaded here — open it in Jira.`}</p>
        )}
        {!open && fold > 0 && (
          <button type="button" className="jira-mention-more" onClick={() => setExpanded(true)}>
            {`Show ${fold} earlier comment${fold === 1 ? '' : 's'}`}
          </button>
        )}
        {comments.length === 0 && posted === null && <p className="jira-detail-none">no comments</p>}
        {shown.map((c) => (
          <Comment key={c.id} comment={c} focused={c.id === focus ? focused : null} asking={asking && c.open} names={names} now={now} />
        ))}
        {posted !== null && <Comment comment={posted} focused={null} asking={false} names={names} now={now} breaks />}
      </div>
    </>
  );
}

function Comment({
  comment,
  focused,
  asking,
  names,
  now,
  breaks = false
}: {
  comment: JiraThreadComment;
  focused: RefObject<HTMLDivElement> | null;
  asking: boolean;
  names: readonly string[];
  now: number;
  /** The reply this dialog just posted: a single newline in it was posted as a `hardBreak`, so it renders as one. A comment read from Jira renders as it
   *  always has — the read side writes a `hardBreak` as a bare newline, which CommonMark renders soft; changing that is the read side's call, not this one. */
  breaks?: boolean;
}) {
  const age = askedAge(comment.created, now);
  const className = asking ? 'jira-mention-cm ask' : 'jira-mention-cm';
  return (
    <div ref={focused ?? undefined} className={className} data-comment-id={comment.id} data-focused={focused !== null ? '' : undefined}>
      {asking && <div className="jira-mention-ask-strip">{age === null ? 'Asks you' : `Asks you · ${age}`}</div>}
      <span className="jira-card-av" aria-hidden="true">
        {initialsOf(comment.author.name)}
      </span>
      <div className="jira-mention-who">
        <span>{comment.mine ? 'You' : comment.author.name}</span>
        {age !== null && <span className="jira-mention-when">{age}</span>}
      </div>
      <div className="item-body jira-mention-txt" dangerouslySetInnerHTML={{ __html: chipMentions(renderMarkdown(comment.markdown, { breaks }), names) }} />
    </div>
  );
}

/**
 * **Open session** for the reply's session: `OpenChip` over `openButtons`' primary decision — the one the Sessions page makes for the same link (Dashboard,
 * the desktop app, or remote on a phone) — under this dialog's own label. A disabled chip until the sessions context has the link: a click before then has
 * nowhere to go.
 */
function SessionChip({
  link,
  sessionId,
  onHandover
}: {
  link: MentionSessionLink | null;
  sessionId: string | null;
  onHandover: (sessionId: string) => void;
}) {
  const phone = useNarrow();
  if (link === null || sessionId === null)
    return (
      <Chip size={28} disabled title="The session has not reported in yet">
        Open session
      </Chip>
    );
  const button = { ...openButtons(link, link.row, link.state, { phone, wide: true }).primary, label: 'Open session' };
  return <OpenChip button={button} sessionId={sessionId} row={link.row} launch={link.surface} primary={false} onHandover={onHandover} />;
}

/**
 * The draft box. The textarea is LOCAL state seeded from the draft: a newer draft (a new `at`) replaces the text only while the person has not edited it;
 * once they have, their words stay and `A newer draft arrived · Use it` offers the swap. Keyed on the ticket by its caller, so a step to another ticket
 * starts from that ticket's draft. Post is refused for a blank text and past `JIRA_REPLY_MAX_CHARS` (the server's own cap, which it re-checks), and a refused
 * post keeps the text — the box stays mounted because the draft does.
 */
function DraftReply({
  issueKey,
  draft,
  to,
  now,
  busy,
  replacing,
  headActs,
  redraftBlocked,
  canRedraft,
  onRedraft,
  onDiscard,
  onPost
}: {
  issueKey: string;
  draft: JiraMentionDraft;
  to: string | null;
  now: number;
  busy: boolean;
  replacing: boolean;
  headActs: ReactNode;
  redraftBlocked: boolean;
  canRedraft: boolean;
  onRedraft: () => void;
  onDiscard: () => void;
  onPost: (text: string) => void;
}) {
  const [seed, setSeed] = useState({ at: draft.at, text: draft.text });
  const [text, setText] = useState(draft.text);
  const edited = text !== seed.text;
  if (draft.at !== seed.at && !edited) {
    setSeed({ at: draft.at, text: draft.text });
    setText(draft.text);
  }
  const newer = draft.at !== seed.at;
  const over = text.length > JIRA_REPLY_MAX_CHARS;
  const age = askedAge(draft.at, now);
  return (
    <div className="jira-reply">
      <div className="jira-reply-head">
        <span className="jira-reply-what">
          <span className="jira-reply-title">Your reply</span>
          <span className="jira-reply-sub">{`drafted by a session ${age ?? 'just now'} · edit before posting`}</span>
        </span>
        {headActs !== null && <span className="jira-mention-foot-acts">{headActs}</span>}
      </div>
      {replacing && <div className="jira-reply-note">This draft is being replaced by a new one; it stays postable until the new one arrives.</div>}
      {newer && (
        <div className="jira-reply-note">
          <span>A newer draft arrived · </span>
          <button
            type="button"
            className="jira-mention-more"
            onClick={() => {
              setSeed({ at: draft.at, text: draft.text });
              setText(draft.text);
            }}
          >
            Use it
          </button>
        </div>
      )}
      {to !== null && <div className="jira-reply-to">{`To @${to}`}</div>}
      <textarea className="jira-reply-text" aria-label={`Reply to ${to ?? issueKey}`} value={text} rows={6} onChange={(e) => setText(e.target.value)} />
      {/* One bar under the text, as the mock draws it: the sentence, the counter pushed right, then the three actions — never a second row of buttons. */}
      <div className="jira-reply-foot">
        <span>{`Posts to ${issueKey} as you and clears this mention.`}</span>
        <span className="jira-reply-count" data-over={over ? '' : undefined}>{`${text.length} / ${JIRA_REPLY_MAX_CHARS}`}</span>
        <span className="jira-reply-acts">
          <Chip
            size={28}
            disabled={busy || redraftBlocked || !canRedraft}
            title={redraftBlocked ? 'Stop the drafting session first' : !canRedraft ? 'Map a repository in Jira › Setup first' : undefined}
            onClick={onRedraft}
          >
            Redraft
          </Chip>
          <Chip size={28} disabled={busy} onClick={onDiscard}>
            Discard
          </Chip>
          <Chip size={28} variant="ink" disabled={busy || text.trim() === '' || over} onClick={() => onPost(text)}>
            Post reply
          </Chip>
        </span>
      </div>
    </div>
  );
}
