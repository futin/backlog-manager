import { useNow } from '../../hooks/useNow';
import { bandSub } from '../../lib/jira';
import type { JiraBoardStatus } from '../../../../shared/types';

/** Shared by Jira › Board and Jira › Sessions (DESIGN.md §8.9.1: the band's sub-line says where the data came from and what is wrong with it). */
/**
 * The band's sub-line on its own one-second clock: `polled 12 s ago` needs seconds, and ticking the whole page for it would re-render every card once a
 * second for a date that changes once a day. `.failing` is the red reading — the class rather than a colour on the text, so the theme owns the red.
 */
export function JiraBandSub({ board, site, fold }: { board: JiraBoardStatus; site: string; fold: { issues: number; cards: number } | null }) {
  const now = useNow(true, 1_000);
  const sub = bandSub(board, site, now, fold);
  return <span className={sub.failing ? 'jira-band-sub failing' : 'jira-band-sub'}>{sub.text}</span>;
}
