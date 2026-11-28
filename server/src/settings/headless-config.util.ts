import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../atomic-write.util';
import { defaultHeadlessConfig, parseHeadlessConfig } from '../../../shared/agent';
import type { HeadlessConfig, HeadlessSetting } from '../../../shared/types';

/**
 * headless-config.util.ts — ~/.backlog-manager/settings/headless.json.
 *
 * Which plugins an orchestrator run's per-item sessions keep: read by `skills/backlog-orchestrate/tools/orchestrate.mjs headless-settings` (the twin parser
 * there), written only by `POST /api/settings/headless`. It follows `review-config.util.ts` on the points that header argues — under `settings/`, the one
 * read-write directory of the `~/.backlog-manager` mount; read fresh per call, cached nowhere; the one write through `writeJsonAtomic` — with one difference.
 *
 * A file that exists but is not a valid config is `source: 'unreadable'`, and a write REFUSES to replace it (409, `HeadlessFileUnreadable`), where review.json's
 * writer replaces it silently. The tool reads such a file as "trim nothing", which is safe; the card shows the defaults, which are NOT what is in force. A
 * save from that card would turn a hand-edited list the person may still want into the defaults without them ever having seen it, so the repair is theirs to
 * make by hand — the same choice `dashboards-file.util.ts` made for dashboards.json.
 */

/** The file, or `BM_HEADLESS_FILE` when set — the same variable `orchestrate.mjs` reads, so one test points both at one temp file. */
export function headlessFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_HEADLESS_FILE || join(homedir(), '.backlog-manager', 'settings', 'headless.json');
}

/** Thrown by `writeHeadless` over a file that exists and is not a valid config; the controller turns it into a 409. */
export class HeadlessFileUnreadable extends Error {
  constructor(readonly file: string) {
    super(`${file} exists but is not a valid headless config — fix or remove it by hand`);
  }
}

/** The config in force and where it came from. Never throws: a missing file is the defaults, an unusable one the defaults marked `unreadable`. */
export function readHeadless(file: string = headlessFile()): HeadlessSetting {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { config: defaultHeadlessConfig(), source: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'default' : 'unreadable' };
  }
  try {
    const parsed = parseHeadlessConfig(JSON.parse(text));
    if (parsed.ok) return { config: parsed.config, source: 'file' };
  } catch {
    // fall through: unparseable JSON is the same answer as a refused shape
  }
  return { config: defaultHeadlessConfig(), source: 'unreadable' };
}

/** Replaces the file with an already-validated config, unless the file there now is unreadable — then nothing is written and it throws. */
export function writeHeadless(config: HeadlessConfig, file: string = headlessFile()): void {
  if (readHeadless(file).source === 'unreadable') throw new HeadlessFileUnreadable(file);
  writeJsonAtomic(file, config);
}
