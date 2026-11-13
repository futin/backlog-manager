import { deliveryIndex, deliveryShown, type DeliveryIndex } from '../lib/delivery';
import type { GitlabPayload } from '../../../shared/types';
import { useGitlabContext } from './GitlabContext';

/**
 * One index per payload, however many surfaces ask. The board draws a chip per shelf card, a line per deck card and a cell per List row, and each reads the
 * shell's one GitLab answer itself (so a card can be rendered alone, under a provided context); a `useMemo` per component would build the index once PER
 * CARD — a scan of every MR the server holds, hundreds of times per poll. Keyed weakly on the payload object, so a new poll's answer is a new key and the old
 * index goes with the old payload: nothing here can serve a stale index, and nothing is held after the shell drops the answer.
 */
const cache = new WeakMap<GitlabPayload, DeliveryIndex>();

/**
 * The delivery index for the shell's current GitLab answer, or `null` while delivery is not shown at all (`deliveryShown`: unconfigured, unarmed, or a
 * payload the browser could not fetch). `null` is every surface's cue to draw nothing — no chip, no band line, no List column — so a GitLab that is down or
 * slow leaves the Jira board exactly as it was (Review Focus 4).
 */
export function useDeliveryIndex(): DeliveryIndex | null {
  const { data } = useGitlabContext();
  if (data === null || !deliveryShown(data)) return null;
  let index = cache.get(data);
  if (index === undefined) {
    index = deliveryIndex(data);
    cache.set(data, index);
  }
  return index;
}
