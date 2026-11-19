import { useId, useState } from 'react';

import { useFetched } from '../../hooks/useFetched';
import { fetchJiraDetail, typeTone, type JiraChildrenIndex } from '../../lib/jira';
import type { GitlabMr, JiraAction, JiraIssue, JiraIssueDetail, ReviewHalf } from '../../../../shared/types';
import { Chip } from '../ui/Chip';
import { JiraTypeIcon } from '../ui/JiraTypeIcon';
import { Modal } from '../ui/Modal';
import { JiraRunMenu } from './JiraRunMenu';
import { JiraTicketBody } from './JiraTicketBody';

/**
 * JiraDetail — one Jira issue's Detail dialog: a thin frame around the ticket body (Jira detail tabs spec §7; DESIGN.md §8.9.2, which applies §8.7's
 * sidecar to a Jira issue; mock `B-Modal.html`). It replaced the Jira issue modal, and since Jira detail tabs everything that modal showed and did is drawn
 * by `JiraTicketBody` — the heading, the summary strip, the tab row and the four panes — which the ticket page draws too. This file draws the frame only.
 *
 * **It is the item modal's twin, not a second dialog design.** It composes `ui/Modal` as `board/ItemModal.tsx` does — so the scrim, the close control, the
 * Escape key (the LIFO stack in `useDialogEscape`, called by the shell and never here) and the 700 px fold are the shell's — and takes the modal's slot on
 * that stack, so the count of dialogs does not change. It passes a `head` and no `facts`: `Modal`'s single shape, one head band over one body at the split
 * shape's width (spec §7.1 keeps today's). The body brought its own strip and tabs, so a second column would only split one reading in two.
 *
 * **The head** holds the crumbs on the left — the type glyph, key and type, the parent as `· in <KEY> <summary>` and the sprint — and on the right
 * `Open full page ↗` (only when the frame was handed `onOpenPage`: Task 8 wires it to the ticket page), `Open in Jira ↗` and `Run ▾`; the shell's close
 * sits past them. The parent here is TEXT, not today's link: the link is the strip's `Parent` cell, because the body owns the parent read and its alert
 * line (`useParentRead`), and a second link up here would be a click whose failure has nowhere to be said. `Run ▾` is `JiraRunMenu`, the card's own chip
 * (`home="modal"`), its pick handed up as `onRun`; the launch sheet is hosted by `JiraView`, ABOVE this dialog, so Escape closes the sheet alone and the
 * dialog under it on the next press. The link out is the issue's `url` as the SERVER built it, in a new tab with no referrer: the browser never talks to
 * Jira.
 *
 * **One name.** The dialog is labelled by the body's `<h2>` (`labelledBy`, `JiraTicketBody`'s `titleId`), never by a string of its own: one title, read
 * once, which cannot drift from the heading the reader sees.
 *
 * **Who owns what** (`JiraTicketBody`'s header has the body's half). The FRAME owns the detail read and its re-read; the BODY owns the one `useAction` write
 * guard and its error line, the parent read, the Worktrees read and the tabs — so this file adds no guard of its own. A landed write calls the frame's
 * `onWrote(reread)`: the board nudge always (`onWrote`, which bumps `JiraView`'s list), and the detail re-read when `reread` says the write landed for the
 * key still shown (spec §6.1; rulings R7, R8). The status reload is the body's.
 *
 * **Two sources, one body.** The card hands over the `JiraIssue` it was drawn from, and every fact the card already carries draws from it at once — the
 * dialog opens full rather than on a spinner. The detail (`GET /api/jira/issue/:key`, read fresh on open) then supplies what a card cannot: the description,
 * the children, the transitions and the boards that hold the issue; it also replaces the card's copy, which may be one poll old. A failed read keeps the
 * card's facts and hands the server's sentence down as `failure`, because a dialog that blanked on a Jira blip would take the readable half down with it.
 *
 * **State belongs to a key.** The detail read is keyed on the issue and on the write revision (`useFetched`, #285), which answers nothing held on the very
 * render that carries a new key, and drops a superseded answer — so reopening on another issue while a read is out never paints the first issue's text
 * under the second one's title. The re-read after a write is a `rev` bump, and the last detail that LANDED for this same key is held and handed down while it
 * is out (R8): no `loading…` flash, and no strip controls blinking to disabled-for-no-detail and back. That held copy is dropped on a key change, during
 * render, so a walk back to an issue (A → B → A) opens on `loading…` like any open, not on A's copy from before the walk.
 *
 * **The walk is `JiraView`'s.** A Children row, a child-live line or the parent link swaps THIS dialog's issue through `onOpenIssue` — never a second
 * `Modal`, since Escape has one owner — and `back` is the issue one step up, which the body's heading draws as `← <key>`. Escape still closes the whole
 * dialog: Back is a step, close is leaving.
 */

type Held = { detail: JiraIssueDetail } | { failure: string };

export function JiraDetail({
  issue,
  childrenOf,
  onOpenIssue,
  back,
  onBack,
  onWrote,
  onRun,
  onReview,
  onOpenPage,
  onClose
}: {
  issue: JiraIssue;
  childrenOf: JiraChildrenIndex | null;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex | null) => void;
  /** The issue a Children-row click came FROM, or `null` on the issue the walk started at — the heading draws `← <key>` only when there is one. */
  back: JiraIssue | null;
  onBack: () => void;
  onWrote: () => void;
  /** `Run ▾`'s pick — the page opens the launch sheet over this dialog. */
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  /** The Delivery pane's CodeRabbit button — the page opens the launch sheet pre-set to a review (spec §5.4). Absent, the row draws no button. */
  onReview?: (issue: JiraIssue, half: ReviewHalf, mr: GitlabMr, repos: string[]) => void;
  /** `Open full page ↗` — the ticket page for this key (Jira detail tabs spec §2.1). Absent, the head draws no such chip. */
  onOpenPage?: (key: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  // Bumped by a landed write for the key still shown: it only TRIGGERS the re-read; the held detail below is what keeps the body up meanwhile (R8).
  const [rev, setRev] = useState(0);
  // The last detail that LANDED — R8's held copy, drawn only while a read for that same key is pending again (a write's re-read). Stored during render on
  // the frame it lands, for the reason `useFetched` tags its answer: an effect would store it one commit late, and that commit would draw `loading…`.
  const [kept, setKept] = useState<JiraIssueDetail | null>(null);
  // The key the held copy may stand in for. Reset DURING render on a key change (React's "adjust state when a prop changes"), so the swapped-in issue's
  // first frame never draws the old one's detail.
  const [shownKey, setShownKey] = useState(issue.key);
  if (shownKey !== issue.key) {
    setShownKey(issue.key);
    setKept(null);
  }

  // Every failure — a non-OK answer, a malformed body, a dropped request — resolves to a `failure`, so the read itself never rejects.
  const { value: mine } = useFetched(
    () =>
      fetchJiraDetail(issue.key)
        .then((detail): Held => ({ detail }))
        .catch((e: unknown): Held => ({ failure: e instanceof Error ? e.message : String(e) })),
    [issue.key, rev]
  );
  const landed = mine !== null && 'detail' in mine ? mine.detail : null;
  if (landed !== null && landed !== kept) setKept(landed);
  const detail = landed ?? (mine === null && kept !== null && kept.key === issue.key ? kept : null);
  const failure = mine !== null && 'failure' in mine ? mine.failure : null;
  // The detail's copy is the fresher one; the card's is what the crumbs draw until it lands (or for good, when the read fails).
  const src: JiraIssue = detail ?? issue;
  const parent = src.parent;

  const head = (
    <div className="jira-detail-head">
      <div className="jira-detail-crumbs">
        <span className="jira-card-type" data-tone={typeTone(src.type)} title={src.type.name}>
          <JiraTypeIcon type={src.type} />
        </span>
        <span className="jira-detail-key">{src.key}</span>
        {src.type.name !== '' && <span>{`· ${src.type.name}`}</span>}
        {/* A stub's parent summary is `''`, so the crumb never ends on a stray space. Text, not a link: see the header. */}
        {parent !== null && (
          <span className="jira-detail-crumb-parent">
            <span className="jira-detail-crumb-in">{'· in '}</span>
            <span>{[parent.key, parent.summary].filter((p) => p !== '').join(' ')}</span>
          </span>
        )}
        {src.sprint !== null && src.sprint !== '' && <span>{`· ${src.sprint}`}</span>}
      </div>
      {/* The frame's actions, at the head's right edge; `Run ▾` is its own popover's positioning parent (`.jira-run`). */}
      <div className="jira-detail-acts">
        {onOpenPage !== undefined && (
          <Chip size={28} onClick={() => onOpenPage(issue.key)}>
            Open full page ↗
          </Chip>
        )}
        {/* A plain link, not a `Chip as="a"`: the chip carries no `target`, and this one must open a new tab with no referrer like every link out. */}
        <a className="jira-detail-out" href={src.url} target="_blank" rel="noreferrer">
          Open in Jira ↗
        </a>
        <JiraRunMenu issue={issue} home="modal" onPick={onRun} />
      </div>
    </div>
  );

  return (
    <Modal labelledBy={titleId} head={head} onClose={onClose}>
      <JiraTicketBody
        issue={issue}
        detail={detail}
        failure={failure}
        childrenOf={childrenOf}
        back={back}
        onBack={onBack}
        onOpenIssue={onOpenIssue}
        onWrote={(reread) => {
          if (reread) setRev((r) => r + 1);
          onWrote();
        }}
        onReview={onReview}
        onRun={onRun}
        titleId={titleId}
      />
    </Modal>
  );
}
