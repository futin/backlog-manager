import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What this server can learn from Claude Code's own process registry (bug-49): `<configDir>/sessions/<pid>.json`, one file per running `claude` process,
 * headless `-p` sessions included. The file is written at process start, kept for the whole life of the process however quiet it is, and REMOVED on a
 * graceful exit — so on the machine that holds a claim, "no file names this session" proves the session exited.
 *
 * **File presence only — never a pid.** `backlog.mjs abort` also tests each entry's pid with `kill(pid, 0)`, which is what catches a HARD kill (the file is
 * left behind, its pid answers `ESRCH`). This server cannot do that: under Docker Desktop the container shares neither the host's pid namespace nor its
 * `~/.claude`, so `kill(pid, 0)` answers `ESRCH` for every host pid and would read every live session as dead. What it can do is read the files, through a
 * read-only mount. A hard-killed session therefore keeps its file and is never swept here; it stays on the fifteen-minute window, and `abort` at the
 * machine clears it.
 *
 * **Fails closed.** `unknown` when the directory is missing or unreadable, or when any `*.json` in it is unreadable or lacks a string `sessionId` and a
 * numeric `pid` — a registry this build does not understand. Reading such a directory as empty would turn every live session on the machine into a dead
 * one, which is the one mistake the sweeper cannot take back. There is no self-check here, unlike the CLI's: a server has no session of its own to look for.
 * The sibling `<pid>.<hash>.key` files are not `*.json` and are not read.
 */
export type SessionRegistry = { kind: 'unknown'; why: string } | { kind: 'read'; sessions: ReadonlySet<string> };

export function readSessionRegistry(dir: string | undefined): SessionRegistry {
  if (dir === undefined || dir.trim() === '') return { kind: 'unknown', why: 'no session registry directory is configured' };

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return { kind: 'unknown', why: `${dir} could not be read` };
  }

  const sessions = new Set<string>();
  for (const name of names) {
    let entry: unknown;
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      return { kind: 'unknown', why: `${name} could not be read as JSON` };
    }
    const e = entry as { sessionId?: unknown; pid?: unknown } | null;
    if (e === null || typeof e !== 'object' || typeof e.sessionId !== 'string' || !Number.isInteger(e.pid)) {
      return { kind: 'unknown', why: `${name} carries no sessionId and pid this build understands` };
    }
    sessions.add(e.sessionId);
  }
  return { kind: 'read', sessions };
}
