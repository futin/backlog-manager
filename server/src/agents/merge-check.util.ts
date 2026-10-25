import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * merge-check.util.ts — a read-only guess at whether a project's Claude Code
 * settings already grant the one Bash capability an orchestrator run needs to
 * merge without hitting the auto-mode classifier: `git merge`. See
 * docs/superpowers/specs/2026-09-04-orchestrator-merge-mode-design.md §6 (and
 * its "Why this exists" section) for the evidence this endpoint answers to —
 * the short version is that auto mode's verdict on an identical `git merge`
 * invocation varies *between runs of the same command*, so an `allow` rule
 * that removes the classifier from the path is worth having and worth
 * telling the reader about, but this function can only ever report "your
 * settings look right", never "your merge will work".
 *
 * ## What a rule has to match, and why it is not a literal string compare
 *
 * Claude Code matches a `Bash(...)` permission rule against the literal command
 * text, `*` standing for any run of characters (spaces included) at any
 * position, and a trailing `:*` being only another spelling of a trailing ` *`.
 * A merge-mode run asks the classifier about two command shapes, and an allow
 * rule only takes the classifier out of the path for the shape it matches:
 *
 *   git merge --no-ff --no-edit HEAD                              (the probe, SKILL.md §2)
 *   git -C "<base tree>" merge --no-ff --no-edit backlog/<id>     (every merge, SKILL.md §9)
 *
 * plus the tracker spelling of each, where three `-m` flags stand in for
 * `--no-edit`. The probe runs from the project root and has no `-C`; the merge
 * does, because the base may live in a tree that is not the cwd. Until #269
 * this file modelled only `git merge --no-ff --no-edit` and so credited
 * `Bash(git merge:*)` — a rule that matches the probe and no real merge, which
 * is the worst pairing there is: the probe passes, the sheet says "covered",
 * and every merge still goes to the classifier.
 *
 * So the check builds `mergeCommandSamples` — those four commands, with the
 * project's own path, quoted, standing in for `<base tree>` — and a settings
 * file covers when every sample matches at least one of its entries. Samples
 * rather than a word-prefix compare because a rule can carry its `*`
 * mid-command (`Bash(git -C * merge --no-ff *)`), and the only faithful way to
 * judge that is to run Claude Code's own matching over a command of the real
 * shape. The per-item parts (`backlog/<id>`, the `-m` texts) vary on every
 * merge, so a rule with no `*` — an EXACT rule — can match at most one past
 * invocation; it is refused outright rather than left to the samples, where it
 * could only ever match by coincidence.
 *
 * The base tree is sampled as the main tree only: that is where the base is
 * checked out on the usual run, and the narrowest safe rule (`mergeAllowRules`,
 * shared/agent.ts, which says why) can name no other tree. A run whose base is
 * checked out nowhere merges in `.worktrees/_base-<ref>`, which that rule does
 * not cover — one more way this answer is "your settings look right" and never
 * "your merge will work". The check credits whatever a file grants, a wildcard
 * `-C` rule included; only the hint is held to the safe pair.
 *
 * Each file is judged on its own: a pair split between `settings.local.json`
 * and `~/.claude/settings.json` reads as not covered, though Claude Code would
 * union them. That errs toward showing the hint, never toward hiding it, and
 * keeps `source` meaning one file.
 *
 * A bare `Bash` entry (no parens at all) is Claude Code's own "allow every
 * command" wildcard and always covers.
 */
export interface MergeCheckResult {
  covered: boolean;
  /** Absolute path of the settings file the covering entry came from, or
   *  `null` when nothing covers it. */
  source: string | null;
}

/**
 * Commands of the four shapes a merge-mode run issues — see the file header.
 * The base tree is the main tree, quoted as SKILL.md writes it.
 */
function mergeCommandSamples(projectPath: string): string[] {
  const trackerMessages = '-m "Merge backlog/1: title" -m "Fixes #1" -m "Reviewed: approve (reviews/1-1.md)"';
  return [
    'git merge --no-ff --no-edit HEAD',
    'git merge --no-ff -m "Merge probe: run-1" -m "Fixes nothing: merge-mode probe" -m "Reviewed: merge-mode probe, no item" HEAD',
    `git -C "${projectPath}" merge --no-ff --no-edit backlog/task-1`,
    `git -C "${projectPath}" merge --no-ff ${trackerMessages} backlog/1`
  ];
}

/** `Bash(<pattern>)` — any rule body; `Bash` alone is handled before this. */
const BASH_RULE_RE = /^Bash\((.*)\)$/s;

/**
 * Claude Code's Bash-rule grammar as a matcher: `:*` at the end is a trailing
 * ` *`, every `*` matches any text, and everything else is literal. `null` for
 * a rule with no `*` at all — an exact rule, which never covers (file header).
 */
function ruleMatcher(entry: string): RegExp | null {
  if (entry === 'Bash') return /^/; // the grammar's own "allow everything"
  const match = BASH_RULE_RE.exec(entry);
  if (match === null) return null;
  const pattern = match[1].endsWith(':*') ? `${match[1].slice(0, -2)} *` : match[1];
  if (!pattern.includes('*')) return null;
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's');
}

/** True when every merge-mode command shape matches at least one of `allow`'s entries. */
function coversMergeCommands(allow: string[], samples: string[]): boolean {
  const matchers = allow.map(ruleMatcher).filter((matcher): matcher is RegExp => matcher !== null);
  return samples.every((command) => matchers.some((matcher) => matcher.test(command)));
}

/**
 * Reads one settings file's `permissions.allow` list. `null` covers every
 * failure this can have — missing file, unreadable file, invalid JSON, or a
 * shape that is not an array (a hand-edited `"allow": "Bash(git:*)"` has
 * been seen in the wild, singular instead of a list) — and it is
 * deliberately indistinguishable from "file exists but grants nothing",
 * because both mean the same thing to `mergeCheck`: keep looking at the next
 * file in precedence order. See that function's own comment for why "never
 * throws" matters more here than telling these apart.
 */
function readAllowList(file: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const allow = (parsed as { permissions?: { allow?: unknown } } | null)?.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((entry): entry is string => typeof entry === 'string') : null;
}

/**
 * Answers whether a project's Claude Code settings already grant `git
 * merge`, and which file the covering entry came from — read in precedence
 * order, project `.claude/settings.local.json` first, then project
 * `.claude/settings.json`, then `<homeDir>/.claude/settings.json` last. The
 * first file with a covering entry wins outright; a later, broader file is
 * never consulted once an earlier one already answers, matching how Claude
 * Code itself layers these three files.
 *
 * Never throws, by construction: this is read to fill in a hint on a launch
 * sheet (Task 8), and an unreadable settings file must not turn that hint
 * into a failed dialog — every failure this function or `readAllowList` can
 * have degrades to "keep looking", and running out of files degrades to
 * `{ covered: false, source: null }`.
 *
 * `projectPath` is assumed to already be a registered project's path — the
 * registry gate that proves that runs one layer up, in
 * AgentsService.mergeCheck, before this function (or the filesystem it
 * reads) is ever touched.
 */
export function mergeCheck(projectPath: string, homeDir: string): MergeCheckResult {
  const candidates = [
    join(projectPath, '.claude', 'settings.local.json'),
    join(projectPath, '.claude', 'settings.json'),
    join(homeDir, '.claude', 'settings.json')
  ];
  const samples = mergeCommandSamples(projectPath);
  for (const file of candidates) {
    const allow = readAllowList(file);
    if (allow !== null && coversMergeCommands(allow, samples)) return { covered: true, source: file };
  }
  return { covered: false, source: null };
}
