import { useEffect, useState } from 'react';

/**
 * The client time a provider's payload last changed to a non-null answer, or `null` before the first. None of the payloads it stamps is stamped by the
 * server with a read time, so this is the board's own clock, taken the render after the answer lands.
 *
 * Called inside the shell's providers (`ProjectsProvider`, `TrackersProvider`, `JiraProvider`, `GitlabProvider`), never inside a reader (#588): the providers
 * mount once with the shell, so the stamp is when the answer arrived. Settings › Shared's Sources card used to call this itself, and since the card mounts
 * when the page opens, its effect stamped every answer as of that moment — `Last read 0 s ago` for an answer five minutes old. A fresh object per fetch is
 * the providers' contract, which is what makes a re-read, even of identical content, a new stamp.
 */
export function useAnsweredAt(data: unknown): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (data !== null) setAt(Date.now());
  }, [data]);
  return at;
}
