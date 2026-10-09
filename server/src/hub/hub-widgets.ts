import { createHubHandler, type HubHandler, type LoadResult, type RowStatus, type State, type WidgetDecl } from 'lookout-widgets';

import { ATTENTION_RUN_STAGES } from '../../../shared/types';
import type { OrchestratorRunsPayload, ProjectSummary, SectionCounts } from '../../../shared/types';

/**
 * hub-widgets.ts — this board's three Lookout hub tiles, served as widget catalog contract v1 under `/api/hub/widgets` through the `lookout-widgets`
 * package (#249, docs/subsystems/api.md "Hub widgets").
 *
 * **Read-only, and that is the point, not a v1 shortcut.** The package does no authentication, and Lookout's POST is server-to-server with no `Origin`
 * header, so an action route here could not pass the guard every other POST in this server carries (`SameOriginPostGuard`) — it would have to be a write
 * path with no guard at all, and the item files and the tracker are written only through guarded routes and the skills. No widget declares an action, so
 * every POST under the route falls to the package's own 404. A row action (releasing a stale claim, say) is a separate item once Lookout has an auth story.
 *
 * **The `run` tile reads THIS machine's run files only** — `payload.runs`, never `payload.remote`. A remote run is another machine's to watch and to rescue,
 * which is the same posture the watchdog takes: it walks local runs and nothing else. A hub that wants that machine's state polls that machine's board.
 *
 * Every tile opens `/` because the client has no URL routing: Board, Runs, Archive and Settings are in-app state, so there is no deeper link to give.
 * No `icon` either: the board's favicon is a `data:` URI in `client/index.html` and the contract wants a relative path — an invalid icon is dropped anyway.
 *
 * The reductions are small exported pure functions so the suite hits them directly; `createBacklogHub` only wires them to the getters.
 */

export interface HubSources {
  projects: () => Promise<ProjectSummary[]>;
  runs: () => OrchestratorRunsPayload;
}

/** `2 bugs`, `1 task` — the one pluralisation every caption and subtitle here goes through. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The `open-total` stat. Bugs and tasks only: an idea or a refactor is not work until it is promoted into a task, and out-of-scope is never open work.
 * `warn` while any bug is open anywhere — that is the reading worth a glance — and `ok` otherwise, zero projects included.
 */
export function openTotal(projects: ProjectSummary[]): LoadResult['stat'] {
  let bugs = 0;
  let tasks = 0;
  for (const p of projects) {
    bugs += p.counts.bugs;
    tasks += p.counts.tasks;
  }
  return { value: bugs + tasks, caption: `${count(bugs, 'bug')} · ${count(tasks, 'task')}`, tone: bugs > 0 ? 'warn' : 'ok' };
}

const SUBTITLE_SECTIONS: ReadonlyArray<readonly [keyof SectionCounts, string]> = [
  ['bugs', 'bug'],
  ['tasks', 'task'],
  ['ideas', 'idea'],
  ['refactors', 'refactor']
];

/** One `projects` row's subtitle: the non-zero open sections in board order, or why there is nothing to count. */
export function projectSubtitle(p: ProjectSummary): string {
  if (p.missing) return 'no backlog/ directory';
  if (p.source === 'unsupported') return 'unsupported source';
  const parts = SUBTITLE_SECTIONS.filter(([section]) => p.counts[section] > 0).map(([section, noun]) => count(p.counts[section], noun));
  return parts.length === 0 ? 'nothing open' : parts.join(' · ');
}

function projectStatus(p: ProjectSummary): RowStatus {
  if (p.missing) return 'error';
  if (p.source === 'unsupported') return 'warn';
  return 'ok';
}

/**
 * The `projects` list, in registry order. A row's id is the project's PATH, not its name: two checkouts of one repo share a name and never a path. With no
 * actions declared, the contract's `.`/`..` row-id restriction (it exists for action paths) cannot bite on an absolute path either.
 */
export function projectRows(projects: ProjectSummary[]): LoadResult['list'] {
  return {
    rows: projects.map((p) => ({ id: p.path, title: p.name, subtitle: projectSubtitle(p), status: projectStatus(p), open: '/' })),
    total: projects.length
  };
}

type LocalRun = OrchestratorRunsPayload['runs'][number];

/** Worst wins: a crashed run anywhere outranks a paused one, which outranks one that is merely running. */
const SEVERITY: Record<State, number> = { error: 3, warn: 2, ok: 1, idle: 0 };

function runState(run: LocalRun): { state: State; label: string } {
  if (run.status === 'running' && !run.fresh) return { state: 'error', label: 'crashed' };
  if (run.status === 'paused') return { state: 'warn', label: 'paused' };
  if (run.status === 'running') {
    return run.queue.some((q) => ATTENTION_RUN_STAGES.includes(q.stage)) ? { state: 'warn', label: 'needs a person' } : { state: 'ok', label: 'running' };
  }
  // done / aborted / failed: a finished run is history, not an alarm that stays lit until the next run starts.
  return { state: 'idle', label: 'no run' };
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The `run` status: every local run reduced to its own state, and the worst of them wins. `detail` names the projects whose runs produced the winning
 * state — and only those, so a crash in one project is not blamed on another's pause. Two `warn` causes (paused, needs a person) tie at one severity; their
 * projects are all named, and the label is the first one met in run order.
 */
export function runStatus(payload: OrchestratorRunsPayload): LoadResult['status'] {
  let best: { state: State; label: string } = { state: 'idle', label: 'no run' };
  let names: string[] = [];
  for (const run of payload.runs) {
    const s = runState(run);
    if (s.state === 'idle') continue;
    if (SEVERITY[s.state] > SEVERITY[best.state]) {
      best = s;
      names = [projectName(run.project)];
    } else if (s.state === best.state) {
      names.push(projectName(run.project));
    }
  }
  return names.length === 0 ? best : { ...best, detail: names.join(', ') };
}

export function createBacklogHub(sources: HubSources): HubHandler {
  const widgets: WidgetDecl[] = [
    { id: 'open-total', title: 'Open work', render: 'stat', refreshSeconds: 60, open: '/', load: async () => openTotal(await sources.projects()) },
    { id: 'projects', title: 'Projects', render: 'list', refreshSeconds: 60, open: '/', load: async () => projectRows(await sources.projects()) },
    { id: 'run', title: 'Orchestrator', render: 'status', refreshSeconds: 15, open: '/', load: () => runStatus(sources.runs()) }
  ];
  return createHubHandler({ app: { name: 'backlog-manager' }, widgets });
}
