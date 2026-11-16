import { type RefObject, useEffect, useRef, useState } from 'react';

import type { JiraIssueDetail, JiraMention, JiraMentionIssue, JiraThreadComment, JiraThreadPayload } from '../../../../shared/types';
import { useFetched } from '../../hooks/useFetched';
import type { JiraMentionsWrite } from '../../hooks/useJiraMentions';
import { useMountedRef } from '../../hooks/useMountedRef';
import { fetchJiraDetail, initialsOf, statusTone, typeTone } from '../../lib/jira';
import { askedAge, chipMentions, fetchJiraThread, mentionIssueType, threadFold } from '../../lib/jira-mentions';
import { renderMarkdown } from '../../lib/markdown';
import { Chevron } from '../ui/Chevron';
import { Chip } from '../ui/Chip';
import { Fact } from '../ui/Fact';
import { Glyph } from '../ui/Glyphs';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Modal } from '../ui/Modal';

/** Where the opened ticket stands in the page's latest answer: still waiting, dismissed, or gone from both (answered, or aged out of the window). */
export type MentionTicketState = 'open' | 'dismissed' | 'gone';

/**
 * DESIGN.md §8.9.1 — the mention modal, thread first (Jira mentions phase 1, Task 10; spec "The mention modal"; mock `ModalA.dc.html` — `ModalB` and
 * `ModalDraft` were not picked, and the draft-a-reply half is phase 2, so nothing here drafts).
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
 * `busy` keeps a double click from posting twice.
 *
 * **Every link out is a server-built `url`** (the mention's focused-comment link, the detail's ticket link), opened by `Chip as="a"` in a new tab with no
 * referrer.
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
  if (shownKey !== issue.key) {
    setShownKey(issue.key);
    setDismissedHere(false);
    setBusy(false);
    setRefused(null);
  }

  // `here` is the `dismissedHere` the write means to leave behind; set before the post so the footer answers the click at once, and put back on a refusal.
  const write = (run: () => Promise<JiraMentionsWrite>, here: boolean): void => {
    const before = dismissedHere;
    setBusy(true);
    setRefused(null);
    setDismissedHere(here);
    void run().then((outcome) => {
      if (!mounted.current) return;
      setBusy(false);
      if (!outcome.ok) {
        setRefused(outcome.message);
        setDismissedHere(before);
      }
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
        <Thread key={issue.key} thread={thread.value} focus={mention.commentId} asking={asking} me={me} now={now} />
      )}
      {state === 'open' ? (
        <div className="jira-mention-foot">
          <span>You have not commented since this mention.</span>
          <span className="jira-mention-foot-acts">
            <Chip disabled={busy} onClick={() => write(onDismiss, true)}>
              Dismiss
            </Chip>
            <Chip variant="ink" as="a" href={mention.url} icon={<Glyph name="external" />}>
              Reply in Jira
            </Chip>
          </span>
        </div>
      ) : state === 'dismissed' && dismissedHere ? (
        <div className="jira-mention-done">
          <span>{`Dismissed. It comes back if someone mentions you on ${issue.key} again.`}</span>
          <Chip size={28} disabled={busy} onClick={() => write(onRestore, false)}>
            Undo
          </Chip>
        </div>
      ) : (
        <div className="jira-mention-foot">
          <span className="jira-mention-foot-acts">
            {state === 'dismissed' && (
              <Chip disabled={busy} onClick={() => write(onRestore, false)}>
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
 */
function Thread({ thread, focus, asking, me, now }: { thread: JiraThreadPayload; focus: string; asking: boolean; me: string | null; now: number }) {
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
        {!open && fold > 0 && (
          <button type="button" className="jira-mention-more" onClick={() => setExpanded(true)}>
            {`Show ${fold} earlier comment${fold === 1 ? '' : 's'}`}
          </button>
        )}
        {comments.length === 0 && <p className="jira-detail-none">no comments</p>}
        {shown.map((c) => (
          <Comment key={c.id} comment={c} focused={c.id === focus ? focused : null} asking={asking && c.open} names={names} now={now} />
        ))}
      </div>
    </>
  );
}

function Comment({
  comment,
  focused,
  asking,
  names,
  now
}: {
  comment: JiraThreadComment;
  focused: RefObject<HTMLDivElement> | null;
  asking: boolean;
  names: readonly string[];
  now: number;
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
      <div className="item-body jira-mention-txt" dangerouslySetInnerHTML={{ __html: chipMentions(renderMarkdown(comment.markdown), names) }} />
    </div>
  );
}
