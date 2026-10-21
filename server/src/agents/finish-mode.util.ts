import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * finish-mode.util.ts — a project's execute finish mode, as the board's dispatch prompt needs it.
 *
 * `<project>/backlog/config.json` holds `{ "execute": { "finish": "in-place" | "pr", "base"?: string } }` (spec "The config"). The skill's own reader,
 * `parseExecuteConfig` in `skills/backlog/tools/backlog.mjs`, is STRICT: a malformed file or an unknown `finish` is an error the skill stops on. This one is
 * deliberately LENIENT and is a second, independent reader — the server imports nothing from `skills/` (a skill is a publishing boundary, and the CLI is a
 * plain `.mjs` with no types) — so the two can disagree only in the direction that is safe: anything this reader would not accept reads as `in-place`, the
 * prompt keeps `COMMIT_RULE`, and the spawned skill then reads the same file with the strict reader and stops with the error. Failing toward `in-place` here
 * therefore never hides a bad config; it only declines to promise a push the skill is about to refuse.
 *
 * Read per request and memoised nowhere, for the same reason as the Orchestrate sheet's `uncommitted` flag: a committed config change has to show on the very
 * next click. Synchronous because it is one small file read on a path that already awaits the item lookup; it never throws, so there is no failure branch for
 * the caller to forget.
 */
export type FinishMode = 'in-place' | 'pr';

export function readFinishMode(projectPath: string): FinishMode {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(projectPath, 'backlog', 'config.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'in-place';
    const execute = (parsed as Record<string, unknown>).execute;
    if (typeof execute !== 'object' || execute === null || Array.isArray(execute)) return 'in-place';
    return (execute as Record<string, unknown>).finish === 'pr' ? 'pr' : 'in-place';
  } catch {
    // No file, unreadable, a directory, malformed JSON: all the same answer.
    return 'in-place';
  }
}
