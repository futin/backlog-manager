import { useState, type ReactNode } from 'react';

import { useAgents } from '../../hooks/useAgents';
import { useDeliveryIndex } from '../../hooks/useDeliveryIndex';
import { useIgnoredSteps } from '../../hooks/useIgnoredSteps';
import {
  deliveryNext,
  deliveryTargets,
  mrRepo,
  targetRowId,
  ticketDelivery,
  UNKNOWN_LINE,
  type DeliveryIndex,
  type TicketDelivery
} from '../../lib/delivery';
import { ignoreKey } from '../../lib/ignored-steps';
import type { SessionLink } from '../../lib/jira-sessions';
import type { GitlabMr, JiraAction, JiraIssue, ReviewHalf } from '../../../../shared/types';
import { DeliveryTargetRow } from './DeliveryTargetRow';
import { NextRow } from './NextRow';

/**
 * JiraDeliveryTab — the Detail body's Delivery tab (Jira detail tabs spec §4; mocks `Main.html`, `States.html`; DESIGN.md §8.9.6, Delivery, and §8.9.2's
 * tab panes). It resolves the ticket's delivery once — the shell's GitLab answer through `useDeliveryIndex`, `ticketDelivery`'s `via` rule unchanged — and
 * draws one of three shapes:
 *
 * - **Nothing** while delivery is not shown or the Jira project maps no GitLab project (the body draws no Delivery tab then either), except the Worktrees
 *   fold when the caller passes one — the body passes it here only while the tab is drawn, so it is never drawn twice.
 * - **Today's sentence** for `none` and `unknown`, copied unchanged from the pane that used to draw them, in place of rows.
 * - **The rows**: a head line (`Branch <source>` when every target's lead shares it, `N targets · M MRs`, `via <parent>`), then one `DeliveryTargetRow` per
 *   (project, target branch) in `deliveryTargets`' order, each with its `NextRow`, then the Worktrees fold.
 *
 * **Which rows are open is the caller's** (`openRows`, `onToggleRow`): independent folds, not an accordion, so a strip pill can open its row from outside
 * the tab and the set survives a poll that swaps a lead (`targetRowId` names the target, never the MR). `useOpenRows` below is that state, for both frames.
 *
 * **One read each, for N rows.** The agents status (the review split's `agents on` condition) and the ignore store are read once, by `TargetRows`, and
 * handed to every row, so five targets do not mount five pollers or five store subscriptions. `TargetRows` mounts only when there are rows: a ticket with
 * no MR, or a project with no delivery, asks the dashboard nothing, as the old lead-only review row did not. `Ignore` and its undo pass the ticket's delivery
 * MRs as `ticketMrs`, which the store prunes against, so an entry for an MR that left the ticket goes on the next write.
 */
export function JiraDeliveryTab({
  issue,
  now,
  onReview,
  onRun,
  openRows,
  onToggleRow,
  onOpenRow,
  liveReviewLink,
  worktrees
}: {
  issue: JiraIssue;
  now: number;
  /** A next row's review split — the frame opens the launch sheet pre-set to a review. Absent, no split draws. */
  onReview?: (issue: JiraIssue, half: ReviewHalf, mr: GitlabMr, repos: string[]) => void;
  /** A next row's `Run ▾` (row 8, a failed pipeline): the frame's own `onRun`, so the second menu opens the same sheet as the head's. */
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  /** The ids (`targetRowId`) of the rows drawn open. */
  openRows: ReadonlySet<string>;
  onToggleRow: (id: string) => void;
  /** Opens one row, leaving the others as they are — a strip pill's click; the body owns the pill, so this tab never calls it. */
  onOpenRow: (id: string) => void;
  /** The newest live link on the key whose action is `review`, or `null` — a `fix` row's `Open session`. */
  liveReviewLink: SessionLink | null;
  /** The Worktrees fold, drawn last, or `null`. */
  worktrees: ReactNode;
}) {
  // `onOpenRow` is part of the contract for a control inside the tab that opens a row; none draws yet (the strip's pills are the body's), so it is unread.
  void onOpenRow;
  const index = useDeliveryIndex();

  const d = index === null ? null : ticketDelivery(issue, index);
  if (index === null || d === null || d.kind === 'hidden') return worktrees === null ? null : <>{worktrees}</>;

  if (d.kind !== 'mrs') {
    const line = d.kind === 'none' ? `no merge request for ${issue.key} in ${d.repos.join(', ')} in the last 30 days` : UNKNOWN_LINE[d.why];
    return (
      <>
        <section className="jira-detail-pane jira-dlv" aria-label="Delivery">
          <div className="jira-dlv-head">
            <div className="jira-detail-lbl">Delivery</div>
          </div>
          <p className="jira-dlv-none">{line}</p>
        </section>
        {worktrees}
      </>
    );
  }

  return (
    <>
      <TargetRows
        issue={issue}
        delivery={d}
        index={index}
        now={now}
        onReview={onReview}
        onRun={onRun}
        openRows={openRows}
        onToggleRow={onToggleRow}
        liveReviewLink={liveReviewLink}
      />
      {worktrees}
    </>
  );
}

/** The head line and the rows of an `mrs` delivery; see the header for why it is its own component. */
function TargetRows({
  issue,
  delivery: d,
  index,
  now,
  onReview,
  onRun,
  openRows,
  onToggleRow,
  liveReviewLink
}: {
  issue: JiraIssue;
  delivery: Extract<TicketDelivery, { kind: 'mrs' }>;
  index: DeliveryIndex;
  now: number;
  onReview?: (issue: JiraIssue, half: ReviewHalf, mr: GitlabMr, repos: string[]) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
  openRows: ReadonlySet<string>;
  onToggleRow: (id: string) => void;
  liveReviewLink: SessionLink | null;
}) {
  const { entries, ignore, unignore } = useIgnoredSteps();
  const { status: agents } = useAgents();
  const agentsOn = agents !== null && agents.enabled;
  const ticketMrs = [d.lead, ...d.also];
  const targets = deliveryTargets(ticketMrs);
  const multiProject = new Set(targets.map((t) => t.project)).size > 1;
  const sources = new Set(targets.map((t) => t.lead.sourceBranch));
  const branch = sources.size === 1 ? targets[0].lead.sourceBranch : null;
  const counts = `${targets.length === 1 ? '1 target' : `${targets.length} targets`} · ${ticketMrs.length === 1 ? '1 MR' : `${ticketMrs.length} MRs`}`;
  // The review candidates per project: the MR's GitLab project as the ISSUE's Jira project sees it (a sub-task's inherited MR shares its parent's project).
  const reposOf = (project: string): string[] => index.jiraProjects[issue.project.key]?.find((p) => p.path === project)?.repos ?? [];

  return (
    <section className="jira-dlv-tab" aria-label="Delivery">
      <div className="jira-dlv-thead">
        {branch !== null && (
          <span className="jira-dlv-branch">
            Branch <code>{branch}</code>
          </span>
        )}
        <span className="jira-dlv-counts">
          {counts}
          {d.via !== null && <span className="jira-dlv-via">{`via ${d.via}`}</span>}
        </span>
      </div>
      {targets.map((t) => {
        const id = targetRowId(t);
        const next = deliveryNext(t.lead, now, entries[ignoreKey(t.lead)]);
        return (
          <DeliveryTargetRow
            key={id}
            target={t}
            next={next}
            repo={multiProject ? mrRepo(t.lead, index) : null}
            open={openRows.has(id)}
            onToggle={() => onToggleRow(id)}
            now={now}
            onUnignore={(step) => unignore(t.lead, step, ticketMrs)}
          >
            <NextRow
              issue={issue}
              mr={t.lead}
              now={now}
              next={next}
              repos={reposOf(t.project)}
              agentsOn={agentsOn}
              liveReviewLink={liveReviewLink}
              onReview={onReview === undefined ? undefined : (half, mr, repos) => onReview(issue, half, mr, repos)}
              onRun={onRun}
              onIgnore={(step) => ignore(t.lead, step, ticketMrs)}
            />
          </DeliveryTargetRow>
        );
      })}
    </section>
  );
}

/**
 * The open Delivery rows for one ticket (spec §4.2, "Which row is open"): `firstId` (the overall lead's row) alone until the reader folds or a pill opens
 * one, then the reader's set; reset when the key changes, during render, so the swapped-in ticket's first frame opens its own first row. Until the reader
 * acts the default FOLLOWS `firstId`, so a poll that changes which target leads opens the new first row rather than none. Functional updates, because a
 * pill's open and a fold's toggle can land in one event.
 */
export function useOpenRows(
  key: string,
  firstId: string | null
): { openRows: ReadonlySet<string>; toggleRow: (id: string) => void; openRow: (id: string) => void } {
  const [held, setHeld] = useState<{ key: string; rows: ReadonlySet<string> | null }>({ key, rows: null });
  const current = held.key === key ? held : { key, rows: null };
  if (held.key !== key) setHeld(current);
  const fallback = (): ReadonlySet<string> => new Set(firstId === null ? [] : [firstId]);
  const openRows = current.rows ?? fallback();
  const edit = (change: (rows: Set<string>) => void): void =>
    setHeld((h) => {
      const rows = new Set(h.key === key && h.rows !== null ? h.rows : fallback());
      change(rows);
      return { key, rows };
    });
  return {
    openRows,
    toggleRow: (id) =>
      edit((rows) => {
        if (rows.has(id)) rows.delete(id);
        else rows.add(id);
      }),
    openRow: (id) => edit((rows) => rows.add(id))
  };
}
