import { SettingsGroup, SettingsRow } from './SettingsRow';
import { useTrackers } from '../../hooks/useTrackers';
import { accessReason, pollAge } from '../../lib/tracker';
import type { TrackerPlatform, TrackerProjectRow } from '../../../../shared/types';

/**
 * The Trackers card (.claude/DESIGN.md §8.6's settings card, applied; spec
 * §5.6) — Shared Settings, `scope="this machine"`, beside Claude Agents.
 *
 * **Read-only, and that is a design decision rather than a phase-2 limit.**
 * Nothing on this card POSTs and there is no connections file: a project is
 * connected by committing `backlog/source.json`, which `backlog.mjs connect`
 * writes, so the marker travels with the repo to every machine instead of
 * being re-entered on each one. A "Connect" button here would be a second
 * writer of that decision — the exact shape the registry's single-writer rule
 * refuses — so what the card offers instead is the COMMAND, as text to copy.
 *
 * Shared rather than Local because everything on it is the host's: the token
 * is in the server's environment, the poll state is in the server's memory,
 * and each project's marker is on the host's disk. The page is the scope
 * (§8.6), so there is no in-page switch and nothing per-device on this card.
 *
 * The token itself is never here. `hasToken` and `login` are what the payload
 * carries (spec §11) and they are what an operator needs: whether a credential
 * is loaded, and whose it is.
 */
export function TrackersGroup() {
  const { data, loading, error } = useTrackers();
  // One instant for the whole card, read here and passed down, because
  // `lib/tracker.ts` states the rule its own header carries: nothing in that
  // module reads a clock, so every age on one surface is aged against one
  // moment. This card has no ticking clock of its own — it re-reads on window
  // focus like `useAgents` — so "now" is the moment it rendered.
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
          {data.projects.map((project) => (
            <SettingsRow key={project.path} name={project.name} hint={<ProjectLine project={project} now={now} />} />
          ))}
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

/** GitHub sends the reset as Unix SECONDS; the card shows a local wall clock,
 *  because the question it answers is "how long do I wait" and a reader is
 *  looking at their own clock while asking it. */
function resetClock(reset: number): string {
  return new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * One registered project: where its items come from, and — for a files project
 * whose `origin` is on GitHub — the command that would connect it, as copyable
 * text.
 */
function ProjectLine({ project, now }: { project: TrackerProjectRow; now: number }) {
  if (project.source === 'github') {
    const reason = accessReason(project);
    const age = pollAge(project.polledAt, now);
    return (
      <>
        github {project.repo} · {reason ?? (age === null ? 'connecting…' : `polled ${age} ago`)}
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
