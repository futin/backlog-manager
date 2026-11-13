import { deliveryLook, type TicketDelivery } from '../../lib/delivery';

/**
 * MrChip — a ticket's lead merge request as one chip (GitLab connection spec §7.2, mock `Cards.dc.html`; DESIGN.md §8.9.1, the card's marker row and the
 * deck card). One component for both board surfaces that draw it — the shelf card's foot, after the worktree chip and before `Run ▾`, and the deck card's
 * own line under the crumb — so the two can never word or tone one MR differently.
 *
 * It draws NOTHING unless the ticket has MRs (`kind: 'mrs'`): `hidden`, `unknown` and `none` all draw nothing on a card. An empty foot already says "no MR"
 * (the mock's `· no MR` text is deliberately not drawn, spec §7.2), and an unknown ticket must not claim one way or the other (spec §7, "Known versus
 * none"). The words and the tone are `deliveryLook`'s card-chip column, never composed here; `title` reads `via <PARENT-KEY>` when the MR is the parent's,
 * inherited by a sub-task with none of its own, so the chip on a sub-task does not read as its own work.
 *
 * `notMerged` adds a second, amber `not merged` chip — the one cross-system mismatch the user most needs to see (Jira says done, GitLab says still open).
 * It is `NotMergedChip`, exported for the List's Delivery cell, which draws the same mark after its word "as on the card" (spec §7, §7.3).
 *
 * Both are spans and not links: the card is a `role="button"` that opens Detail, where the MR's link out lives, and a link inside it would be a second
 * target competing for the same click. Each ellipsises before `Run ▾` gives any width (`.jira-mr-chip`, the worktree chip's rule).
 */
export function MrChip({ delivery, now }: { delivery: TicketDelivery; now: number }) {
  if (delivery.kind !== 'mrs') return null;
  const look = deliveryLook(delivery.lead, now);
  return (
    <>
      <span className="jira-mr-chip" data-tone={look.tone} title={delivery.via === null ? undefined : `via ${delivery.via}`}>
        {look.chip}
      </span>
      {delivery.notMerged && <NotMergedChip />}
    </>
  );
}

/** The amber `not merged` mark: the ticket is done in Jira while its own lead MR is still open (spec §7.2). Never raised by an inherited MR. */
export function NotMergedChip() {
  return (
    <span className="jira-mr-chip" data-tone="amber">
      not merged
    </span>
  );
}
