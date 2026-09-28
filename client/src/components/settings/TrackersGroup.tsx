import { useState } from 'react';

import { SettingsGroup, SettingsRow } from './SettingsRow';
import { Segmented } from '../ui/Segmented';
import { useTrackersContext } from '../../hooks/TrackersContext';
import { resetClock, trackerState } from '../../lib/tracker';
import { DEFAULT_SYNC_INTERVAL, SYNC_INTERVALS } from '../../../../shared/types';
import type { SyncInterval, TrackerPlatform, TrackerProjectRow } from '../../../../shared/types';

/** The picker's options: the shared constant's keys, in its order — never a second list (spec §11's pin, `test/settings-trackers.test.tsx`). */
const INTERVAL_OPTIONS = (Object.keys(SYNC_INTERVALS) as SyncInterval[]).map((value) => ({ value, label: value }));

/**
 * The Trackers card (.claude/DESIGN.md §8.6's settings card, applied; spec
 * §5.6) — Shared Settings, `scope="this machine"`, beside Claude Agents.
 *
 * **Connecting is read-only here, and that is a design decision rather than a
 * phase-2 limit.** There is no connections file: a project is connected by
 * committing `backlog/source.json`, which `backlog.mjs connect` writes, so the
 * marker travels with the repo to every machine instead of being re-entered on
 * each one. A "Connect" button here would be a second writer of that decision —
 * the exact shape the registry's single-writer rule refuses — so what the card
 * offers instead is the COMMAND, as text to copy.
 *
 * **The one control is each repo's sync interval** (#17; DESIGN.md §8.6's
 * pill, as the Display rows draw it). That setting is the opposite case from a
 * connection: it is how often THIS machine asks GitHub, so it belongs to the
 * machine and not the repo — `settings/tracker-sync.json`, written by
 * `POST /api/trackers/sync` alone. The pill shows the server's answer after a
 * refetch, never the value clicked, and a refusal (turning a repo off under a
 * live run) keeps the old value selected with the server's sentence as the
 * row's hint. Two checkouts of one repo share the key, so both rows move.
 *
 * Shared rather than Local because everything on it is the host's: the token
 * is in the server's environment, the poll state is in the server's memory,
 * and each project's marker is on the host's disk. The page is the scope
 * (§8.6), so there is no in-page switch and nothing per-device on this card.
 *
 * The token itself is never here. `hasToken` and `login` are what the payload
 * carries (spec §11) and they are what an operator needs: whether a credential
 * is loaded, and whose it is.
 *
 * It no longer owns the fetch: the shell does (`TrackersProvider` in `App`), so this card and the strip chip read one answer on one clock.
 */
export function TrackersGroup() {
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
  // One instant for the whole card, read here and passed down, because
  // `lib/tracker.ts` states the rule its own header carries: nothing in that
  // module reads a clock, so every age on one surface is aged against one
  // moment. This card has no ticking clock of its own — it re-renders when the
  // shell's `useTrackers` answers (on the poll clock, and on focus) — so "now"
  // is the moment it rendered.
  const now = Date.now();

  return (
    <SettingsGroup title="Trackers" scope="this machine">
      {data === null ? (
        <SettingsRow name="GitHub" hint={loading ? 'checking…' : 'unavailable'} />
      ) : (
        <>
          {data.platforms.map((platform) => (
            <SettingsRow key={platform.kind} name={platformName(platform.kind)} hint={platformLine(platform)} />
          ))}
          {data.projects.map((project) => {
            const repo = project.source === 'github' ? project.repo : null;
            const refusal = repo === null ? undefined : refusals[repo];
            return (
              <SettingsRow key={project.path} name={project.name} hint={refusal ?? <ProjectLine project={project} now={now} />}>
                {repo !== null && (
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
                )}
              </SettingsRow>
            );
          })}
          {data.projects.length === 0 && <SettingsRow name="Projects" hint="nothing registered yet" />}
        </>
      )}
      {error && data !== null && <SettingsRow name="Trackers" hint="the last read failed — showing the previous answer" />}
    </SettingsGroup>
  );
}

/** The platform's display name. A function rather than the raw kind so the
 *  card reads as a person writes it (`GitHub`, not `github`) without the
 *  payload carrying presentation. */
function platformName(kind: string): string {
  return kind === 'github' ? 'GitHub' : kind;
}

/**
 * `as futin · 4,812 of 5,000 left · resets 14:32`, or the sentence that says
 * what to do about an absent token. The fix rather than the symptom, for the
 * reason `accessReason` gives: this is the one state an operator can clear
 * from the machine they are sitting at.
 */
function platformLine(platform: TrackerPlatform): string {
  if (!platform.hasToken) return 'no token — set BM_GITHUB_TOKEN in .env and restart';
  const parts = [platform.login === null ? 'token set' : `as ${platform.login}`];
  if (platform.remaining !== null && platform.limit !== null) {
    parts.push(`${platform.remaining.toLocaleString()} of ${platform.limit.toLocaleString()} left`);
  }
  if (platform.reset !== null) parts.push(`resets ${resetClock(platform.reset)}`);
  // Nothing about the budget before the first request of this process: the
  // numbers are read off response headers, so "0 of 0 left" would be a
  // reading rather than an absence.
  return parts.join(' · ');
}

/**
 * One registered project: where its items come from, and — for a files project
 * whose `origin` is on GitHub — the command that would connect it, as copyable
 * text.
 */
function ProjectLine({ project, now }: { project: TrackerProjectRow; now: number }) {
  if (project.source === 'github') {
    // `trackerState` (lib/tracker.ts) — the item modal's own words for the same connection, `sync off` included since #17.
    return (
      <>
        github {project.repo} · {trackerState(project, now)}
      </>
    );
  }
  if (project.source === 'unsupported') return <>a source marker this build cannot read — see the board’s warnings</>;
  if (project.source === null) return <>no backlog/ store</>;
  return (
    <>
      files
      {project.connect !== null && (
        <>
          {' · '}
          {/* The command, not a button: connecting writes a marker that has to
              be COMMITTED, so the act belongs in the repo where someone can
              review and push it. Selectable text is the copy path deliberately
              — a copy button on a read-only card is a control, and this card
              has none. */}
          {/* A bare `code`: `.set-hint code` already carries this card's
              inline-code look (`styles.css`), so a class of its own here would
              be a second home for one appearance — guard 7's rule. */}
          <code>{project.connect}</code>
        </>
      )}
    </>
  );
}
