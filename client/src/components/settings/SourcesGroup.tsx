import type { ReactNode } from 'react';

import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { useJiraContext } from '../../hooks/JiraContext';
import { useTimeZone } from '../../hooks/TimeZoneContext';
import { useTrackersContext } from '../../hooks/TrackersContext';
import type { JiraPage } from '../../lib/jira-page';
import type { GithubPage } from '../../lib/source-page';
import { projectsPerSource, sourceSectionOf } from '../../lib/sources';
import { platformLine, reachLines } from '../../lib/tracker';
import type { TrackerProjectRow } from '../../../../shared/types';

/**
 * Settings › Shared's `Sources · this machine` card (.claude/DESIGN.md §8.6's settings card, applied; source-sections spec, "Parts of the how") — what is
 * connected on this machine, and whether it works, in one card: one row per source in rail order, Files, GitHub, Jira. Adding a source later is adding a
 * row of this shape. First on the page because it is the page's answer to "what does this machine have", which every other card on Shared presumes.
 *
 * **Read-only, by the same design decision the Trackers card it replaces made.** There is no connections file: a project is connected by committing
 * `backlog/source.json`, which `backlog.mjs connect` writes, so the marker travels with the repo instead of being re-entered on each machine. A "Connect"
 * button here would be a second writer of that decision — the exact shape the registry's single-writer rule refuses — so the Files row offers the COMMAND,
 * as text to copy. The one setting that card did carry, each repo's sync interval, is GitHub › Settings' now (`GithubSyncGroup`).
 *
 * Shared rather than Local because everything here is the host's: the token is in the server's environment, the poll state in its memory, each marker on
 * its disk, and Jira's configuration in its settings file. The token itself is never here — `hasToken` and `login` are what the payload carries.
 *
 * **The links are the shell's pair, never a switch of this card's own.** `onOpenGithubPage` and `onOpenJiraPage` are built once in `App` (page store first,
 * then `change`) and threaded down through `SettingsView`, the one allowance the rail's tree rule makes; without them the row names no destination. Each is
 * drawn only while the section it opens is drawn — GitHub with a registered github project, Jira while configured — because a link into a section
 * the rail does not draw would land on a page the shell immediately falls away from.
 *
 * It owns no fetch: the shell's `TrackersProvider` and `JiraProvider` do, so this card, GitHub › Settings and the strip chips read one answer each.
 */
export function SourcesGroup({ onOpenGithubPage, onOpenJiraPage }: { onOpenGithubPage?: (p: GithubPage) => void; onOpenJiraPage?: (p: JiraPage) => void }) {
  const { zone } = useTimeZone();
  const { data, loading, error } = useTrackersContext();
  const jira = useJiraContext();
  // One instant for the whole card, read here and passed down, because `lib/tracker.ts` reads no clock: every age on one surface is aged against one moment.
  // The card has no ticking clock of its own — it re-renders when the shell's `useTrackers` answers — so "now" is the moment it rendered.
  const now = Date.now();
  const pending = loading ? 'checking…' : 'unavailable';

  const counts = data === null ? null : projectsPerSource(data.projects);
  const platform = data?.platforms.find((p) => p.kind === 'github');

  return (
    <SettingsGroup title="Sources" scope="this machine">
      <SettingsRow
        name="Files"
        hint={
          data === null || counts === null ? (
            <Lines lines={[pending]} />
          ) : (
            <Lines lines={[projectCount(counts.files), ...data.projects.filter((p) => sourceSectionOf(p.source) === 'files').flatMap(filesLine)]} />
          )
        }
      />

      <SettingsRow
        name="GitHub"
        hint={
          data === null || counts === null ? (
            <Lines lines={[pending]} />
          ) : (
            <Lines
              lines={[
                ...(platform === undefined ? [] : [platformLine(platform, zone)]),
                projectCount(counts.github),
                ...reachLines(data.projects, now).map((r) => r.line)
              ]}
            />
          )
        }
      >
        {counts !== null && counts.github > 0 && onOpenGithubPage && (
          // A button, not an anchor: the destination is the shell's own state, not an href (the watchdog card's `Runs › Watchdog ↗` is the precedent).
          <button type="button" className="set-link" onClick={() => onOpenGithubPage('settings')}>
            GitHub › Settings ↗
          </button>
        )}
      </SettingsRow>

      <SettingsRow name="Jira" hint={<Lines lines={[jiraLine(jira.data, jira.loading)]} />}>
        {jira.data?.configured === true && onOpenJiraPage && (
          <button type="button" className="set-link" onClick={() => onOpenJiraPage('setup')}>
            Jira › Setup ↗
          </button>
        )}
      </SettingsRow>

      {error && data !== null && <SettingsRow name="Last read" hint="the last read failed — showing the previous answer" />}
    </SettingsGroup>
  );
}

/** A hint of several lines, each its own block (`.set-hint-line`), so one line is one reading and no reader — or test — sees two run together. */
function Lines({ lines }: { lines: ReactNode[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <span key={i} className="set-hint-line">
          {line}
        </span>
      ))}
    </>
  );
}

function projectCount(n: number): string {
  return `${n} ${n === 1 ? 'project' : 'projects'}`;
}

/**
 * What a Files-row project has to say, or nothing: a files project's `backlog.mjs connect` command when its `origin` is on GitHub, an unsupported marker's
 * pointer to the board's warnings, a lost store. A files project with nothing to connect adds no line — the count already says it is there.
 */
function filesLine(project: TrackerProjectRow): ReactNode[] {
  if (project.source === 'unsupported') return [`${project.name} · a source marker this build cannot read — see the board’s warnings`];
  if (project.source === null) return [`${project.name} · no backlog/ store`];
  if (project.connect === null) return [];
  return [
    <>
      {project.name} · {/* The command, not a button: connecting writes a marker that has to be COMMITTED, so the act belongs in the repo where someone can
          review and push it. A bare `code`, because `.set-hint code` already carries this card's inline-code look (`styles.css`). */}
      <code>{project.connect}</code>
    </>
  ];
}

/** `configured · acme.atlassian.net · 2 boards`, `not configured`, or the read's own state before Jira has answered. */
function jiraLine(data: ReturnType<typeof useJiraContext>['data'], loading: boolean): string {
  if (data === null) return loading ? 'checking…' : 'unavailable';
  if (!data.configured) return 'not configured';
  const n = data.boards.length;
  return `configured · ${data.site ?? '—'} · ${n} ${n === 1 ? 'board' : 'boards'}`;
}
