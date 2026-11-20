import { useId } from 'react';

import { useTicketDetail } from '../../hooks/useTicketDetail';
import { typeTone, type JiraChildrenIndex } from '../../lib/jira';
import type { GitlabMr, JiraAction, JiraIssue, ReviewHalf } from '../../../../shared/types';
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
 * `Open full page ↗` (only when the frame was handed `onOpenPage`, which `JiraView` always is: it closes this dialog and opens the ticket page), `Open in Jira ↗` and `Run ▾`; the shell's close
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
 * **State belongs to a key.** The detail read is `useTicketDetail`'s, shared with the ticket page: keyed on the issue and on the write revision, so reopening
 * on another issue while a read is out never paints the first issue's text under the second one's title; the re-read after a write is its `reread()`, and
 * the last detail that LANDED for this same key is handed down while it is out (R8) — no `loading…` flash, and no strip controls blinking to disabled and
 * back. The held copy is dropped on a key change, so a walk back to an issue (A → B → A) opens on `loading…` like any open.
 *
 * **The walk is `JiraView`'s.** A Children row, a child-live line or the parent link swaps THIS dialog's issue through `onOpenIssue` — never a second
 * `Modal`, since Escape has one owner — and `back` is the issue one step up, which the body's heading draws as `← <key>`. Escape still closes the whole
 * dialog: Back is a step, close is leaving. A Children row Cmd-, Ctrl- or middle-clicked is not a step but an exit (spec §2.3): it goes to the ticket page on
 * that child through the same `onOpenPage` as the head's chip, so the walk is left behind with the dialog.
 */

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
  // The read, its R8 held copy and its re-read are `useTicketDetail`'s — the hook the ticket page reads through too (see the header's last two sections).
  const { detail, failure, reread } = useTicketDetail(issue.key);
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
        onWrote={(again) => {
          if (again) reread();
          onWrote();
        }}
        onReview={onReview}
        onRun={onRun}
        onOpenPage={onOpenPage === undefined ? undefined : (child) => onOpenPage(child.key)}
        titleId={titleId}
      />
    </Modal>
  );
}
