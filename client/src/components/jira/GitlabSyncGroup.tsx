import { useState } from 'react';

import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Segmented } from '../ui/Segmented';
import { useGitlabContext } from '../../hooks/GitlabContext';
import { errorOf, postJson } from '../../lib/http';
import { SYNC_INTERVALS, isSyncInterval } from '../../../../shared/types';
import type { SyncInterval } from '../../../../shared/types';

/** The picker's options: the shared constant's keys, in its order — never a second list, the same derivation `GithubSyncGroup` makes. */
const INTERVAL_OPTIONS = (Object.keys(SYNC_INTERVALS) as SyncInterval[]).map((value) => ({ value, label: value }));

/**
 * Jira › Setup's `GitLab` card (.claude/DESIGN.md §8.6's settings card, applied; §8.9.3 for the page; #527) — how often this machine's GitLab poller sweeps,
 * the one setting GitLab has. It is `GithubSyncGroup`'s card with one row instead of one per repo, because the GitLab poller reads every mapped project in
 * ONE sweep: there is no per-repo cadence to pick, so the value is per machine (`settings/gitlab-sync.json`, written by `POST /api/gitlab/sync` alone) and
 * the card carries the page's `this machine` scope. It sits on Jira › Setup rather than on a GitLab page because GitLab has none — the MRs it reads are drawn
 * on Jira tickets, and the repos it reads are the ones this page's Repositories card maps.
 *
 * **It renders nothing until there is something true to say.** No answer yet, GitLab `unconfigured` (no site or token in the environment, so no poller to
 * pace), or an answer with no `interval` — an API one release older than this client, the `withReviewDefaults` situation in `useGitlab.ts` — each draws no
 * card, rather than a pill holding a value the server never said. A wrong selected value would be worse than an absent card: it would read as the setting.
 *
 * The pill shows the server's answer after a refetch, never the value clicked — `GithubSyncGroup`'s rule, for its reason: a save the server refused (a
 * `gitlab-sync.json` that does not parse is a 409 that writes nothing) must leave the old value selected, and only the server knows which happened. A refusal's
 * sentence replaces the row's hint until the next pick, and a request that never reached the server reads `could not save — <message>`. The pill is
 * disabled while a save and its refetch are out, so a second click cannot race the first one's answer.
 *
 * It owns no fetch of its own: the shell's `GitlabProvider` does, so this card, the Sources row and the ticket MR rows read one answer on one clock.
 */
export function GitlabSyncGroup() {
  const { data, refresh } = useGitlabContext();
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  if (data === null || data.status.state === 'unconfigured' || !isSyncInterval(data.status.interval)) return null;
  const current = data.status.interval;

  const save = async (interval: SyncInterval): Promise<void> => {
    setSaving(true);
    setRefusal(null);
    try {
      const res = await postJson('/api/gitlab/sync', { interval });
      if (!res.ok) setRefusal(errorOf(res.body, `could not save (HTTP ${res.status})`));
      await refresh();
    } catch (e) {
      setRefusal(`could not save — ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup title="GitLab" scope="this machine">
      <SettingsRow name="Sync interval" hint={refusal ?? `${data.status.site ?? 'GitLab'} · every mapped repo, one sweep`}>
        <Segmented
          value={current}
          options={INTERVAL_OPTIONS}
          onChange={(interval) => {
            if (interval !== current) void save(interval);
          }}
          disabled={saving}
          label="Sync interval"
          pill
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
