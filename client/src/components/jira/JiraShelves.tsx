import { useState } from 'react';

import { SHELF_LIMIT, type Shelf } from '../../lib/jira-deck';
import type { JiraColumnSlug, JiraChildrenIndex } from '../../lib/jira';
import type { JiraAction, JiraBoard, JiraIssue, JiraWorktree } from '../../../../shared/types';
import { BoardColumn } from '../board/BoardColumn';
import { Chip } from '../ui/Chip';
import { JiraCard } from './JiraCard';

/**
 * JiraShelves — the board's tops by status category, under the agent deck (Jira sessions spec §7.1, C8; DESIGN.md §8.9.1). It is the Board's three columns of
 * before (`BoardColumn`, `.jira-board-columns`), and what is new is only the cut: To Do and In Progress show their first 8 rows and Done its 3 newest, each
 * with a `+ N more` that opens that shelf for as long as this page is mounted, and `show fewer` that closes it again.
 *
 * The count pill is the shelf's whole count, not the shown rows — what the reader would find by opening it — and the rows are `JiraCard`s with the card's
 * every field, because §7.1 keeps all of §8's board items on a row. Which tops are here at all (the filters, and the tops a live session took to the deck)
 * is `boardShelves`' answer; this component only slices it. The open set is per mount and nothing is persisted, as the filters are.
 */
export function JiraShelves({
  shelves,
  board,
  me,
  now,
  treesOf,
  childrenOf,
  onOpenIssue,
  onRun
}: {
  shelves: readonly Shelf[];
  board: JiraBoard;
  me: { accountId: string } | null;
  now: number;
  treesOf: (key: string) => readonly JiraWorktree[];
  childrenOf: JiraChildrenIndex;
  onOpenIssue: (issue: JiraIssue, childrenOf: JiraChildrenIndex) => void;
  onRun: (issue: JiraIssue, action: JiraAction) => void;
}) {
  const [opened, setOpened] = useState<ReadonlySet<JiraColumnSlug>>(new Set());
  const toggle = (slug: JiraColumnSlug): void =>
    setOpened((o) => {
      const next = new Set(o);
      if (!next.delete(slug)) next.add(slug);
      return next;
    });

  return (
    <div className="board-columns jira-board-columns">
      {shelves.map((shelf) => {
        const limit = SHELF_LIMIT[shelf.slug];
        const open = opened.has(shelf.slug);
        const rows = open ? shelf.cards : shelf.cards.slice(0, limit);
        const hidden = shelf.cards.length - limit;
        return (
          <BoardColumn key={shelf.slug} slug={shelf.slug} tone={shelf.slug} ground label={shelf.label} count={shelf.cards.length}>
            {rows.map((c) => (
              <JiraCard
                key={c.issue.key}
                issue={c.issue}
                board={board}
                me={me}
                now={now}
                fold={c.fold}
                matches={c.matches}
                ended={c.ended}
                trees={treesOf(c.issue.key)}
                onOpen={(issue) => onOpenIssue(issue, childrenOf)}
                onRun={onRun}
              />
            ))}
            {hidden > 0 && (
              <div className="jira-shelf-more">
                <Chip variant="flat" size={28} aria-expanded={open} onClick={() => toggle(shelf.slug)}>
                  {open ? 'show fewer' : `+ ${hidden} more`}
                </Chip>
              </div>
            )}
          </BoardColumn>
        );
      })}
    </div>
  );
}
