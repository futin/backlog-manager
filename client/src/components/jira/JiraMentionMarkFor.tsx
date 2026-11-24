import { useMentionIndex } from '../../hooks/JiraMentionsContext';
import { MentionMark } from '../ui/MentionMark';
import { useOpenMention } from './MentionOpenContext';

/**
 * The board's `@ N` mark for one ticket (DESIGN.md §8.9.7; Jira mentions <-> board link, Task 4): the connector between the shell's mention index and the
 * presentational `MentionMark`. It draws only when BOTH exist — the ticket is waiting on the user (the index holds open issues only) and something above can
 * open the modal (`useOpenMention` is non-null) — so a card, a lane header or a list row mounts it unconditionally and no caller guards either case.
 */
export function JiraMentionMarkFor({ issueKey }: { issueKey: string }) {
  const entry = useMentionIndex().get(issueKey);
  const open = useOpenMention();
  if (entry === undefined || open === null) return null;
  return <MentionMark count={entry.mentions.length} onOpen={() => open(issueKey)} />;
}
