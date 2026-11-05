import { useEffect, useRef, useState, type ReactNode } from 'react';

import { SettingsGroup, SettingsRow } from '../ui/SettingsRow';
import { StatusPill } from '../ui/StatusPill';
import { useJiraContext } from '../../hooks/JiraContext';
import { useProjectsContext } from '../../hooks/ProjectsContext';
import { useTimeZone } from '../../hooks/TimeZoneContext';
import { useTrackersContext } from '../../hooks/TrackersContext';
import type { JiraPage } from '../../lib/jira-page';
import type { GithubPage } from '../../lib/source-page';
import { githubDown, jiraDown, serviceTone } from '../../lib/service-status';
import { projectsPerSource, sourceSectionOf } from '../../lib/sources';
import { postSweep, refusalText, type SweepOutcome } from '../../lib/sweep';
import type { StateTone } from '../../lib/tones';
import { platformLine, pollAge, reachLines } from '../../lib/tracker';
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
 * drawn only while the section it opens is drawn — GitHub while the rail draws its row (`useProjectsContext().drawn`), Jira while configured — because a link into a section
 * the rail does not draw would land on a page the shell immediately falls away from.
 *
 * It owns no fetch: the shell's `TrackersProvider`, `JiraProvider` and `ProjectsProvider` do, so this card, GitHub › Settings, the rail and the strip chips
 * read one answer each.
 */
export function SourcesGroup({
  onOpenFilesPage,
  onOpenGithubPage,
  onOpenJiraPage
}: {
  onOpenFilesPage?: () => void;
  onOpenGithubPage?: (p: GithubPage) => void;
  onOpenJiraPage?: (p: JiraPage) => void;
}) {
  const { zone } = useTimeZone();
  const trackers = useTrackersContext();
  const { data, loading, error } = trackers;
  const jira = useJiraContext();
  // The rail's own answer (`GET /api/projects`), read for the GitHub link's gate alone — see the comment on the link.
  const projects = useProjectsContext();
  const drawn = projects.drawn;
  const answers = [useAnsweredAt(projects.data), useAnsweredAt(data), useAnsweredAt(jira.data)].filter((t): t is number => t !== null);
  // The oldest of the three latest answers: the moment since which ALL answered. Sources that have not answered at all do not hold the foot back.
  const answeredAt = answers.length === 0 ? null : Math.min(...answers);
  const [reading, setReading] = useState(false);
  const [readNotice, setReadNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  // One instant for the whole card, read here and passed down, because `lib/tracker.ts` reads no clock: every age on one surface is aged against one moment.
  // The card has no ticking clock of its own — it re-renders when the shell's `useTrackers` answers — so "now" is the moment it rendered.
  const now = Date.now();
  const pending = loading ? 'checking…' : 'unavailable';

  const counts = data === null ? null : projectsPerSource(data.projects);
  const platform = data?.platforms.find((p) => p.kind === 'github');

  // The three pills. Each reads its source's own answer through the same predicates the shell's strip chips use (`serviceTone`, `githubDown`, `jiraDown`), so
  // a card and a chip cannot disagree about "down" or "late". Files has no age and no poll: it is green the moment the registry answered.
  const githubRows = data?.projects.filter((p) => p.source === 'github') ?? [];
  const githubTone: StateTone | null =
    data === null
      ? null
      : serviceTone(
          { down: githubDown(platform?.hasToken === true, githubRows.map((r) => r.access)), rows: githubRows, limited: githubRows.some((r) => r.access === 'rate-limited') },
          now
        );
  const jiraTone: StateTone | null =
    jira.data === null || !jira.data.configured
      ? null
      : serviceTone({ down: jiraDown(jira.data.access), rows: jira.data.boards, limited: jira.data.access === 'rate-limited' }, now);

  // Read again: both sweeps, then every context re-reads. A sweep's 409 means nothing is armed to sweep (Jira unconfigured, no github repo), which is not an
  // error on a card whose job is to say what the machine has; anything else is a sentence under the foot. A ref guards the double click `reading` cannot.
  const readAgain = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setReading(true);
    setReadNotice(null);
    const [github, jiraOutcome] = await Promise.all([postSweep('github'), postSweep('jira')]);
    const outcomes: ['github' | 'jira', SweepOutcome][] = [
      ['github', github],
      ['jira', jiraOutcome]
    ];
    projects.reload();
    trackers.reload();
    jira.reload();
    const refused = outcomes.flatMap(([service, o]) => (o.ok || o.status === 409 ? [] : [refusalText(service, o, zone)]));
    setReadNotice(refused.length === 0 ? null : refused.join(' · '));
    inFlight.current = false;
    setReading(false);
  };

  // The per-project lines — a files project's connect command, a repo's reach — sit behind each row's `ⓘ more` (spec §4.10: text longer than a line). Ten
  // repos drew ten hint lines on this machine, which pushed the card a screen tall where the mock draws one line per source (ui-verify 2026-11-05).
  const fileLines = data === null ? [] : data.projects.filter((p) => sourceSectionOf(p.source) === 'files').flatMap(filesLine);
  const repoLines = data === null ? [] : reachLines(data.projects, now).map((r) => r.line);

  return (
    <SettingsGroup title="Sources" pill="this machine">
      <SettingsRow
        name="Files"
        hint={data === null || counts === null ? <Lines lines={[pending]} /> : <Lines lines={['backlog/ folders in the registry']} />}
        more={fileLines.length > 0 ? <Lines lines={fileLines} /> : undefined}
      >
        <StatusPill tone={counts === null ? 'grey' : 'green'} word={counts === null ? pending : projectCount(counts.files)} />
        {drawn?.files === true && onOpenFilesPage && (
          <button type="button" className="set-link" onClick={onOpenFilesPage}>
            Open
          </button>
        )}
      </SettingsRow>

      <SettingsRow
        name="GitHub"
        hint={
          data === null || counts === null ? (
            <Lines lines={[pending]} />
          ) : (
            <Lines lines={[...(platform === undefined ? [] : [platformLine(platform, zone)]), projectCount(counts.github)]} />
          )
        }
        more={repoLines.length > 0 ? <Lines lines={repoLines} /> : undefined}
      >
        <StatusPill tone={githubTone ?? 'grey'} word={githubTone === null ? pending : CARD_WORD[githubTone]} />
        {/* Gated on the rail's `drawn`, never on `counts`: the counts read `/api/trackers` and the rail reads `/api/projects`, two separate fetches that can be
            out of step. "Drawn only while the section it opens is drawn" is the rail's fact, so it is read where the rail reads it; unknown (`null`) draws no
            link, as the rail draws no row on a guess. */}
        {drawn?.github === true && onOpenGithubPage && (
          // A button, not an anchor: the destination is the shell's own state, not an href (the watchdog card's `Runs › Watchdog ↗` is the precedent).
          <button type="button" className="set-link" onClick={() => onOpenGithubPage('settings')}>
            GitHub page
          </button>
        )}
      </SettingsRow>

      <SettingsRow name="Jira" hint={<Lines lines={[jiraLine(jira.data, jira.loading)]} />}>
        <StatusPill
          tone={jiraTone ?? 'grey'}
          word={jiraTone !== null ? CARD_WORD[jiraTone] : jira.data === null ? (jira.loading ? 'checking…' : 'unavailable') : 'not configured'}
        />
        {jira.data?.configured === true && onOpenJiraPage && (
          <button type="button" className="set-link" onClick={() => onOpenJiraPage('setup')}>
            Jira setup
          </button>
        )}
      </SettingsRow>

      {error && data !== null && <SettingsRow name="Last read" hint="the last read failed — showing the previous answer" />}

      {readNotice !== null && (
        <div className="set-row set-error-row" role="alert">
          <span className="set-error">{readNotice}</span>
        </div>
      )}

      {/* The card's foot: when all three sources last answered (client time — none of the three payloads is stamped with one) and the one control that asks them
          again. Never a ticking clock: the age is as of this render, like every other age on the card. */}
      <div className="set-foot">
        <span>{answeredAt === null ? 'Not read yet' : `Last read ${pollAge(new Date(answeredAt).toISOString(), now)} ago`}</span>
        <button type="button" className="set-link set-foot-action" disabled={reading} onClick={() => void readAgain()}>
          Read again
        </button>
      </div>
    </SettingsGroup>
  );
}

/** The word on a source's pill for each tone — the card's own vocabulary ("connected"), where the strip chip's `TONE_WORD` is its accessible name ("on time"). */
const CARD_WORD: Record<StateTone, string> = { green: 'connected', amber: 'late', red: 'down', grey: 'not polled yet' };

/** The client time a context's payload last changed to a non-null answer, or `null` before the first. A fresh object per fetch is the contexts' contract. */
function useAnsweredAt(data: unknown): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (data !== null) setAt(Date.now());
  }, [data]);
  return at;
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
