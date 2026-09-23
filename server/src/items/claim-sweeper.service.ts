import { Injectable } from '@nestjs/common';

import { readSessionRegistry } from './session-registry.util';
import { GithubSource } from './sources/github.source';
import { resolveSource } from './sources/resolve.util';
import { RegistryService } from '../registry/registry.service';
import { claimsByIssue, isLive } from '../tracker/claim';
import { TrackerPollerService } from '../tracker/poller.service';

/** Where the session registry is, as the server sees it. Compose mounts `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions` read-only at the same absolute
 *  path and sets this to it; a host run (`pnpm run dev`) sets it in `.env`. Unset means the sweeper does nothing — today's behaviour. */
export const SESSIONS_DIR_ENV = 'BM_CLAUDE_SESSIONS_DIR';

/** `released.by` on every claim this service releases, so the record says who did it. Not shaped like a session id on purpose: nothing may mistake it
 *  for one, and no claim is ever taken under it. */
export const CLAIM_SWEEPER_SESSION = 'backlog-manager:claim-sweeper';

/** A Claude Code session id. The `<user>@<host>` fallback a session with no `CLAUDE_CODE_SESSION_ID` claims under has no registry entry by construction,
 *  so it would always read gone — it never matches this. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN: ReadonlySet<string> = new Set(['github']);

/**
 * The claim sweeper (bug-49): releases a hand-run session's claim once this machine's session registry shows the session has exited.
 *
 * A session stopped mid-item passes through no terminal stage, so it releases nothing, and the item read as in progress on every machine for a full
 * `CLAIM_STALE_MS` though the machine that held it already knew the process was gone. bug-48 added the clause that lets the HOLDING machine release such a
 * claim (`GithubSource.release`'s `sameHost`) and `backlog.mjs abort` to invoke it — but nothing invoked it without a person. This does, for the
 * graceful-exit case, and runs inside the poller's tick (`onRepoSynced`) so it is armed exactly while the poller is.
 *
 * A claim is released only when EVERY one of these holds, each for a reason that is a failure somebody would otherwise pay for:
 *
 * - **live and not a run's.** A dead claim is retired by the next `start` already. A run's claim has its own recovery path (the watchdog's resume,
 *   `orchestrate.mjs abort`), and releasing it between a driver crash and its resume would hand the item to somebody else mid-run.
 * - **`session` is a Claude Code session id**, never the `<user>@<host>` fallback, which is in no registry and would always read gone.
 * - **`host` is one this process has been told is its own** — `noteOwnHost`, fed by the `host` on every `POST /api/items/claim` this server receives.
 *   The API is loopback-bound, so those callers are on this machine. This is what keeps bug-46's false negative out: a foreign claim's host is never in
 *   the set, so the absence of a local registry entry is never read as death for a session this machine could not have seen. In memory only, never
 *   written, the way starting runs are: after a restart nothing is swept until some session on the machine has claimed through this server again, and
 *   until then a claim waits out the window, which is the behaviour before this service existed.
 * - **the registry is readable, understood, and no file in it names the session** — `readSessionRegistry`, which fails closed. File presence only: this
 *   server never tests a registry pid, because inside the container every host pid answers `ESRCH`. So a HARD-killed session, whose file is left behind,
 *   is never swept here; it stays on the fifteen-minute window and `abort` at the machine clears it.
 *
 * **Known limit:** a session run under a DIFFERENT `CLAUDE_CONFIG_DIR` from the one mounted writes its registry file elsewhere, so it reads gone here
 * while it is running. One config dir per machine is the supported shape; a machine that runs two should leave `BM_CLAUDE_SESSIONS_DIR` unset.
 */
@Injectable()
export class ClaimSweeperService {
  private readonly ownHosts = new Set<string>();

  constructor(
    private readonly poller: TrackerPollerService,
    private readonly github: GithubSource,
    private readonly registry: RegistryService
  ) {
    this.poller.onRepoSynced((repo) => this.sweepRepo(repo));
  }

  /** A `host` a claim request carried — see the class header for why that makes it this machine's. */
  noteOwnHost(host: string | undefined): void {
    if (typeof host === 'string' && host.trim() !== '') this.ownHosts.add(host);
  }

  /**
   * One pass over one repo's cached claims. One release per claim, no retry inside a tick: the next tick is the retry, and it re-reads everything.
   * The cache may be a poll old; `release` re-reads the claim fresh before it edits anything, so a claim the holder released or the cache misread in
   * the meantime comes back as `conflict` or `not-found`, which is not an error here.
   */
  async sweepRepo(repo: string): Promise<void> {
    if (this.ownHosts.size === 0) return;
    const project = this.projectFor(repo);
    if (project === null) return;

    const now = Date.now();
    const candidates: Array<{ number: number; commentId: number; host: string; session: string }> = [];
    for (const [number, claims] of claimsByIssue(this.poller.comments(repo))) {
      for (const { commentId, record } of claims) {
        if (!isLive(record, now) || record.run !== undefined) continue;
        if (!SESSION_ID.test(record.session)) continue;
        if (typeof record.host !== 'string' || !this.ownHosts.has(record.host)) continue;
        candidates.push({ number, commentId, host: record.host, session: record.session });
      }
    }
    if (candidates.length === 0) return;

    // Read once per sweep and only when there is something to decide, so a repo with nothing held never touches the directory.
    const sessions = readSessionRegistry(process.env[SESSIONS_DIR_ENV]);
    if (sessions.kind !== 'read') return;

    for (const c of candidates) {
      if (sessions.sessions.has(c.session)) continue;
      // `host` set to the claim's OWN host — bug-48's `sameHost` clause, satisfied by the machine that holds the claim. No `counters` (the abandon rule:
      // the stretch between the last heartbeat and the exit is not work anybody did) and no `runId` (a hand claim has no run).
      await this.github.release(project.project, project.marker, {
        project: project.project.path,
        id: `#${c.number}`,
        commentId: c.commentId,
        session: CLAIM_SWEEPER_SESSION,
        reason: 'aborted',
        host: c.host
      });
    }
  }

  /** The first registered project whose committed marker names `repo` — the same resolution `TrackerPollerService.connectedRepos` makes. */
  private projectFor(repo: string) {
    for (const project of this.registry.load().projects) {
      const resolved = resolveSource(project.path, KNOWN);
      if (resolved.kind === 'tracker' && resolved.marker.repo === repo) return { project, marker: resolved.marker };
    }
    return null;
  }
}
