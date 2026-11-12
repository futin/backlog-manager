import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from '../atomic-write.util';
import { DEFAULT_REVIEW_CONFIG, parseReviewConfig } from '../../../shared/agent';
import type { ReviewConfig, ReviewSetting } from '../../../shared/types';

/**
 * review-config.util.ts — ~/.backlog-manager/settings/review.json.
 *
 * Which model and effort review a branch's diff, read by `skills/backlog-review/tools/review.mjs` and written by `POST /api/settings/review`. It follows
 * `timezone-config.util.ts` on every point that header argues: it lives under `settings/`, the one read-write directory carved out of the read-only
 * `~/.backlog-manager` mount; it is read fresh per call and cached nowhere; and the one write goes through `writeJsonAtomic`.
 *
 * A reader never throws. A file that does not parse, or parses to something `parseReviewConfig` refuses, reads as the defaults with `fileError: true`, so the
 * Settings card can say "this file was ignored" while the skill (which warns and uses the same defaults) and the board keep agreeing on what is in force.
 * Unlike `jira.json` a write does not refuse to replace such a file: it holds one value and the write replaces it whole, so the person saving is the repair.
 */

/** The file, or `BM_REVIEW_FILE` when set — the same variable `review.mjs` reads, so a test points both at one temp file. */
export function reviewFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BM_REVIEW_FILE || join(homedir(), '.backlog-manager', 'settings', 'review.json');
}

/** A fresh copy, so no caller can mutate the shared defaults. */
const defaults = (): ReviewConfig => structuredClone(DEFAULT_REVIEW_CONFIG);

/** The config in force: the file when valid, else the defaults — silently when the file is missing, with `fileError` when it exists and is unusable. */
export function readReview(file: string = reviewFile()): ReviewSetting {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? defaults() : { ...defaults(), fileError: true };
  }
  try {
    const parsed = parseReviewConfig(JSON.parse(text));
    return parsed.ok ? parsed.config : { ...defaults(), fileError: true };
  } catch {
    return { ...defaults(), fileError: true };
  }
}

/** Replaces the file with an already-validated config. */
export function writeReview(config: ReviewConfig, file: string = reviewFile()): void {
  writeJsonAtomic(file, config);
}
