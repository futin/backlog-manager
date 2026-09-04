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
 * ## The matching rule, and why it is not a literal string compare
 *
 * Claude Code's own `Bash(<prefix>:*)` permission grammar matches the START
 * of the literal command line. The command backlog-orchestrate actually
 * issues (skills/backlog-orchestrate/SKILL.md) is:
 *
 *   git -C "$PWD" merge --no-ff --no-edit backlog/<id>
 *
 * A literal prefix compare of THAT string against a rule like
 * `Bash(git merge:*)` — the rule a person would actually write, because
 * nobody hand-writes a rule around a `-C` flag naming a directory that
 * changes on every run — would answer "not covered" for a project that is,
 * in every sense a reader cares about, already set up correctly. That false
 * negative is the wrong failure to optimize against here: this endpoint's
 * only job is a setup hint, and a hint that calls a correct setup broken
 * sends the reader hunting for a problem that does not exist. So the
 * comparison target below is not the raw argv — it is that argv with the
 * `-C "$PWD"` clause and the per-item branch name removed, because `-C`
 * changes WHERE git runs, never WHAT capability is being granted, and
 * nothing about the permission surface depends on which branch is named.
 * What remains, `MERGE_COMMAND_WORDS` below, is the fixed, meaningful part
 * of the command this endpoint checks coverage against.
 *
 * That asymmetry has a cost the rest of this comment doesn't otherwise
 * mention: an allow entry that spells the `-C "$PWD"` clause out literally —
 * `Bash(git -C "$PWD" merge:*)`, which mirrors SKILL.md's own invocation
 * almost verbatim and is exactly what a careful user might copy straight out
 * of it — does NOT match `MERGE_COMMAND_WORDS` (its second word is `-C`, not
 * `merge`) and so reports `covered: false`, even though that command would
 * genuinely cover the real invocation under the literal-prefix grammar. That
 * is a false negative, which is the safe direction this whole file already
 * argues for, so it is left as-is rather than "fixed" — recorded here only
 * so a future reader doesn't mistake it for an oversight.
 *
 * A candidate entry then "covers" that target when its own prefix, split on
 * whitespace, is a WHOLE-WORD prefix of `MERGE_COMMAND_WORDS` — matched word
 * by word, never as a raw substring, so a coincidental textual prefix (say,
 * `Bash(git me:*)`) is never counted as covering a command it does not
 * actually name. Three shapes fall out of that one rule, and they are the
 * three the design spec pins as the test of this decision:
 *
 *   - `Bash(git merge:*)`         — exactly MERGE_COMMAND_WORDS's own
 *                                   prefix. Covers.
 *   - `Bash(git merge --no-ff:*)` — narrower than the family name, but every
 *                                   one of its words matches the actual
 *                                   flags issued, in order. Covers.
 *   - `Bash(git:*)`               — broader still, one word. Covers.
 *   - `Bash(git status:*)`        — a different git subcommand entirely;
 *                                   "status" is not "merge" no matter how
 *                                   broad `git:*` would have been. Does not
 *                                   cover.
 *
 * A bare `Bash` entry (no parens at all) is Claude Code's own "allow every
 * command" wildcard and always covers. An entry with no trailing `:*` is an
 * EXACT-command rule — it matches one literal invocation, not a family of
 * them — and is deliberately treated as NOT covering: `<id>` varies on every
 * run, so an exact rule can cover at most one past invocation, never the
 * capability a future run needs. Counting it as covering would be exactly
 * the overclaim the rest of this comment argues against.
 */
export interface MergeCheckResult {
  covered: boolean;
  /** Absolute path of the settings file the covering entry came from, or
   *  `null` when nothing covers it. */
  source: string | null;
}

/**
 * The fixed part of `git -C "$PWD" merge --no-ff --no-edit backlog/<id>`
 * (SKILL.md) once the location flag (`-C "$PWD"`) and the per-item branch
 * name are removed — see the file header for why both are dropped from the
 * comparison target rather than from the rule text a user would write.
 */
const MERGE_COMMAND_WORDS = ['git', 'merge', '--no-ff', '--no-edit'];

/** `Bash(<prefix>:*)` — Claude Code's own wildcard-prefix grammar. */
const WILDCARD_RE = /^Bash\((.*):\*\)$/;

/**
 * True when every word of `prefix`, in order, matches the start of
 * MERGE_COMMAND_WORDS — see the file header for the three shapes this must
 * accept or refuse.
 */
function coversMergeCommand(prefix: string): boolean {
  const words = prefix.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0 || words.length > MERGE_COMMAND_WORDS.length) return false;
  return words.every((word, i) => word === MERGE_COMMAND_WORDS[i]);
}

/** One `permissions.allow` entry, judged against Claude Code's own grammar. */
function entryCoversGitMerge(entry: string): boolean {
  if (entry === 'Bash') return true; // the grammar's own "allow everything"
  const match = WILDCARD_RE.exec(entry);
  return match !== null && coversMergeCommand(match[1]);
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
  for (const file of candidates) {
    const allow = readAllowList(file);
    if (allow !== null && allow.some(entryCoversGitMerge)) return { covered: true, source: file };
  }
  return { covered: false, source: null };
}
