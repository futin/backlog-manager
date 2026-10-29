import { useState } from 'react';

import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { Segmented } from '../ui/Segmented';
import { useTrackersContext } from '../../hooks/TrackersContext';
import { DEFAULT_SYNC_INTERVAL, SYNC_INTERVALS } from '../../../../shared/types';
import type { SyncInterval } from '../../../../shared/types';

/** The picker's options: the shared constant's keys, in its order — never a second list (spec §11's pin, `test/github-settings.test.tsx`). */
const INTERVAL_OPTIONS = (Object.keys(SYNC_INTERVALS) as SyncInterval[]).map((value) => ({ value, label: value }));

/**
 * GitHub › Settings' `Sync` card (.claude/DESIGN.md §8.6's settings card, applied; source-sections spec, "Parts of the how") — each registered github
 * project's sync interval, moved here from Settings › Shared's old Trackers card when that card was split by subject. The card's reports (token, login,
 * rate limit, each repo's reach, the connect commands, the Jira row) went to the Sources card on Shared; only the one control came here, because it is a
 * GitHub setting and a person looking at GitHub's items is where it is looked for.
 *
 * **The one control is each repo's sync interval** (#17; §8.6's pill, as the Display rows draw it). It is how often THIS machine asks GitHub, so it
 * belongs to the machine and not the repo — `settings/tracker-sync.json`, written by `POST /api/trackers/sync` alone — which is why the page's band carries
 * the `this machine` pill and why a host card may sit on a source page at all (Jira › Setup is the precedent). The pill shows the server's answer after a
 * refetch, never the value clicked, and a refusal (turning a repo off under a live run) keeps the old value selected with the server's sentence in place of
 * the row's `<repo>` hint until the next pick for that repo. Two checkouts of one repo share the key, so both rows move — which is why the hint is the repo:
 * it names the setting, and the project name beside it names the checkout.
 *
 * It owns no fetch: the shell's `TrackersProvider` does, so this card, the Sources card and the strip chip read one answer on one clock.
 */
export function GithubSyncGroup() {
  const { data, loading, error, saveInterval, refusals } = useTrackersContext();
  // One save in flight per repo: the pill is disabled until its answer lands, so a second click cannot race the first one's refetch.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const save = (repo: string, interval: SyncInterval): void => {
    setSaving((prev) => new Set(prev).add(repo));
    void saveInterval(repo, interval).finally(() =>
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(repo);
        return next;
      })
    );
  };

  const projects = data === null ? [] : data.projects.filter((p) => p.source === 'github' && p.repo !== null);

  return (
    <SettingsGroup title="Sync" scope="this machine">
      {data === null ? (
        <SettingsRow name="Projects" hint={loading ? 'checking…' : 'unavailable'} />
      ) : (
        <>
          {projects.map((project) => {
            // Narrowed by the filter above; the local keeps the closure below from re-asking.
            const repo = project.repo as string;
            return (
              <SettingsRow key={project.path} name={project.name} hint={refusals[repo] ?? repo}>
                <Segmented
                  value={project.interval ?? DEFAULT_SYNC_INTERVAL}
                  options={INTERVAL_OPTIONS}
                  onChange={(interval) => {
                    if (interval !== project.interval) save(repo, interval);
                  }}
                  disabled={saving.has(repo)}
                  label="Sync interval"
                  pill
                />
              </SettingsRow>
            );
          })}
          {/* Reachable only while the shell holds the GitHub section after its last project went (the rail draws no GitHub row with none), so this is a
              moment's reading, not a page anyone navigates to. */}
          {projects.length === 0 && <SettingsRow name="Projects" hint="nothing registered yet" />}
        </>
      )}
      {error && data !== null && <SettingsRow name="Last read" hint="the last read failed — showing the previous answer" />}
    </SettingsGroup>
  );
}
