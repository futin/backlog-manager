import { useState } from 'react';

import { fetchJiraDetail } from '../lib/jira';
import type { JiraIssueDetail } from '../../../shared/types';
import { useFetched } from './useFetched';

/**
 * useTicketDetail — one ticket's detail read (`GET /api/jira/issue/:key`, `fetchJiraDetail`), the one both frames of the ticket body make: the Detail
 * dialog reads the card's key, the ticket page reads the key store (Jira detail tabs spec §2.1, §7.2; DESIGN.md §8.9.2). One hook, so the held-copy rule
 * below cannot be kept by one frame and lost by the other.
 *
 * **State belongs to a key.** The read is keyed on the key and on a revision (`useFetched`, #285), which answers nothing held on the very render that
 * carries a new key and drops a superseded answer — so swapping to another ticket while a read is out never paints the first one's text under the second
 * one's title. `reread()` bumps the revision: the re-read after a landed write (rulings R7, R8) and the page's `Retry`.
 *
 * **The held copy** (R8). The last detail that LANDED for the key is kept, stored during render on the frame it lands — an effect would store it one commit
 * late, and that commit would draw `loading…`. It is dropped on a key change, during render, so a walk back to a ticket (A → B → A) opens on `loading…` like
 * any open, never on A's copy from before the walk. Two readings of it:
 *
 * - `detail` — the landed answer, or the held copy while a re-read for the same key is OUT: what a frame hands the body, so a write's re-read never flashes
 *   `loading…` or blinks the strip's controls to disabled-for-no-detail and back. A FAILED read gives `null` here, as the modal has always drawn it.
 * - `kept` — the held copy whatever the read's state, failure included: the page has no card to fall back on, so it draws a failed re-read over the ticket
 *   it already showed (spec §2.1) rather than dropping to its pre-issue frame.
 *
 * Every failure — a non-OK answer, a malformed body, a dropped request — resolves to `failure`, the sentence `fetchJiraDetail` rejects with.
 */

type Held = { detail: JiraIssueDetail } | { failure: string };

export interface TicketDetail {
  detail: JiraIssueDetail | null;
  kept: JiraIssueDetail | null;
  failure: string | null;
  reread: () => void;
}

export function useTicketDetail(key: string): TicketDetail {
  const [rev, setRev] = useState(0);
  const [kept, setKept] = useState<JiraIssueDetail | null>(null);
  // The key the held copy may stand in for. Reset DURING render on a key change (React's "adjust state when a prop changes"), so the swapped-in ticket's
  // first frame never draws the old one's detail.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setKept(null);
  }

  const { value: mine } = useFetched(
    () =>
      fetchJiraDetail(key)
        .then((detail): Held => ({ detail }))
        .catch((e: unknown): Held => ({ failure: e instanceof Error ? e.message : String(e) })),
    [key, rev]
  );
  const landed = mine !== null && 'detail' in mine ? mine.detail : null;
  if (landed !== null && landed !== kept) setKept(landed);
  const held = kept !== null && kept.key === key ? kept : null;
  return {
    detail: landed ?? (mine === null ? held : null),
    kept: landed ?? held,
    failure: mine !== null && 'failure' in mine ? mine.failure : null,
    reread: () => setRev((r) => r + 1)
  };
}
