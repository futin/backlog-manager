import { basename } from 'node:path';

import { COMMIT_RULE, defuseFinishFlags, finishClause, oneLine } from '../../../shared/agent';
import type { AgentAction } from '../../../shared/agent';
import type { BacklogItem, ExecuteFinish, FinishFlags } from '../../../shared/types';

/**
 * prompt.util.ts — what the spawned session is actually told to do.
 *
 * Natural language naming the skill, NOT a slash command. Whether `claude -p`
 * expands a `/skill` in a prompt piped on stdin is unverified against this
 * CLI, and the skills' own descriptions are written to trigger on exactly this
 * phrasing ("groom the backlog", "use the backlog-execute skill"), so the
 * documented path is also the safe one. test/agents-prompt.test.ts asserts no
 * slash command ever appears.
 *
 * Lifecycle bookkeeping is not mentioned: backlog-execute runs `backlog.mjs
 * start` itself and backlog-groom does its own `move`. Asking for it here
 * would be a second answer to a question the skills already own.
 */

const SKILL: Record<AgentAction, string> = {
  groom: 'backlog-manager:backlog-groom',
  execute: 'backlog-manager:backlog-execute',
  capture: 'backlog-manager:backlog-capture'
};

export function composePrompt(item: BacklogItem, action: AgentAction): string {
  // The title is defused of `--finish`/`--base`/`--auto-merge`/`--fix` tokens for every action — one rule, and harmless for capture — because for an execute
  // or a groom, dispatch's rule 8 would otherwise refuse the board's own untouched prompt over a title that merely mentions a flag.
  const head = `Use the ${SKILL[action]} skill on ${item.id} — "${defuseFinishFlags(oneLine(item.title))}" — in this repo's backlog.`;
  // An execute's or groom's closing clause is NOT part of the composed prompt: the launch sheet's finish picker owns it, and `AgentsService.dispatch` appends
  // `finishClause(action, finish, base, flags)` from validated fields after the sheet's body (`appendFinishClause` below). Were it here, in the textarea the
  // person may edit, deleting ` --finish pr` from the text would leave the sheet showing PR while the session stays in place. Capture writes a new item file,
  // never opens a PR, and has no picker, so its `COMMIT_RULE` stays in the editable text as it always did.
  if (action === 'execute' || action === 'groom') return [head, instruction(item, action)].join(' ');
  return [head, instruction(item, action), COMMIT_RULE].join(' ');
}

/**
 * The prompt `AgentsService.dispatch` actually spawns: the sheet's body, then the finish clause for an execute or a groom, the body alone for a capture.
 *
 * A groom body that ends in `COMMIT_RULE` — a tab opened before the clause left the editable text, or a hand-edited prompt that kept it — loses ONE trailing
 * copy (with the whitespace before it) first. Under `in-place` the clause is `COMMIT_RULE` again, so the sent bytes are what an old tab always produced; under
 * `pr` the old sentence ends "Do not push.", the opposite of the clause that follows, and would be the session's second-to-last word. Only a trailing copy is
 * stripped: one quoted mid-prompt is the person's own text. An execute is deliberately not stripped — its prompt never carried the rule, a body that does is
 * the "doubled, harmless" case `agents-dispatch.test.ts` pins, and rewriting it would be a behaviour change nobody asked for.
 */
export function appendFinishClause(body: string, action: AgentAction, finish: ExecuteFinish, base: string, flags: FinishFlags): string {
  if (action === 'capture') return body;
  let text = body;
  if (action === 'groom') {
    const trimmed = body.trimEnd();
    if (trimmed.endsWith(COMMIT_RULE)) text = trimmed.slice(0, trimmed.length - COMMIT_RULE.length).trimEnd();
  }
  const clause = finishClause(action, finish, base, flags);
  return text === '' ? clause : `${text} ${clause}`;
}

/**
 * The action- and section-specific middle of the prompt — everything between
 * the "use this skill on this item" head and the commit rule capture alone
 * keeps in its text (an execute and a groom have none here: dispatch appends their finish clause). Split out so the closing rule is appended in exactly one
 * place: when it lived at the end of each branch's own template, the next branch added was the one that forgot it.
 */
function instruction(item: BacklogItem, action: AgentAction): string {
  if (action === 'execute') {
    // "verify" and "archive" are the two halves backlog-execute refuses to
    // separate.
    return 'Work it through to verification, then archive the item. Report what you changed.';
  }
  if (action === 'capture') {
    // Keyed on the ACTION, beside `execute` above, rather than on
    // `section === 'out-of-scope'` below with the section branches: capture is
    // the one thing this item's own directory can never be talked into, and
    // stating it as a section rule would put the "which directory" question in
    // front of the "which action" answer that `deriveAction` already settled.
    //
    // Three things have to be in the sentence, and each of them is a way this
    // goes wrong if left out: a NEW item (an agent handed a rejected item and
    // told to "revive" it will otherwise try to move the file, which `moveItem`
    // refuses outright); the `from:` citation (without it the revival loses the
    // only link back to the reasoning that rejected it); and the original left
    // alone (the rejection record IS the point — see the design's own
    // "promotion out of Archive").
    //
    // BOTH routes to that citation are named, and the redundancy is load-
    // bearing rather than belt-and-braces. `--from <id>` is the flag that
    // writes the `from:` line (backlog.mjs's `new`), and until this change
    // `backlog-capture`'s SKILL.md banned it outright — "capture doesn't do it,
    // even when the new item was clearly inspired by an existing one" — with a
    // rationale that reads as a ban on the citation itself, not on one spelling
    // of it. That skill now carries an explicit revive exception, but
    // `skills/` is a publishing boundary: an install is a copy of the pushed
    // HEAD, so until this branch is committed, pushed and `pnpm run
    // plugin:sync` has run, every session this prompt reaches is still running
    // the version that bans the flag. Naming the hand-written line as the
    // second route is what keeps the citation reachable under the OLD skill
    // too — its step 3 already has the reader adding `tags:` and `kind:` to
    // frontmatter by hand and bans only `status:`. Do not "simplify" this to
    // one route on the grounds that the skill now allows the flag; the two
    // sides ship independently and this is the seam.
    return `It was ruled out of scope. File a NEW item that revives it, and give that new item a from: ${item.id} line in its frontmatter — either by passing --from ${item.id} to the backlog tool's new command, or by writing that line into the frontmatter by hand the way a tags: line is added. The citation is required: it is the revived item's only link back to the rejection. Leave ${item.id} itself exactly where it is — the rejection stays on the record.`;
  }
  // Refactors share this branch, not the fallback at the bottom: grooming one
  // promotes it into a task exactly as grooming an idea does, so the
  // instruction is the same sentence. Without this they fell through to the
  // task fallback ("give it a plan") — which reads as an instruction to edit
  // the refactor in place, the one thing a promote must not do.
  if (item.section === 'ideas' || item.section === 'refactors') {
    return `Promote it to a task with a real, executable plan.`;
  }
  if (item.section === 'bugs') {
    // "Leave the item in bugs/open/" is the whole difference between grooming a
    // bug and executing it: groom fills the two headings and moves nothing.
    return `Investigate it and fill in ## Cause and ## Fix. Leave the item in bugs/open/.`;
  }
  // A task with no Plan — only reachable from a hand-made file, since
  // backlog-capture refuses to create one without.
  return `Give it a plan concrete enough to execute.`;
}

/**
 * The `-n` name the dashboard row is labelled with. Prefixed `bl ` so a row
 * this board started is recognisable among sessions started from a terminal.
 *
 * Spaces, not the `bl:<project>/<id>` this used to emit. That spelling was
 * silently discarded on 100% of dispatches: the dashboard's own
 * `NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/` (`server/lib/spawn.ts`) allows
 * neither `:` nor `/`, and `parseSpawnRequest` drops an invalid name to
 * `undefined` under a documented fail-soft rule rather than rejecting the
 * request. So `-n` never reached the CLI and every row fell back to the bare
 * project name — indistinguishable from a terminal-started session, which is
 * the entire affordance this function exists to buy.
 *
 * test/agents-prompt.test.ts asserts the composed name against a copy of that
 * regex, so the cross-app contract is pinned rather than assumed. It is a
 * copy on purpose: importing from a sibling repo would make this repo's tests
 * depend on a checkout of another one.
 *
 * Sliced to that app's `NAME_CAP` (60) for the same reason: over the cap is
 * the same silent drop, and a long project name plus a long id can reach it.
 * A truncated name still reads as ours; no name at all does not.
 */
export function sessionName(item: BacklogItem): string {
  return `bl ${item.project} ${item.id}`.slice(0, 60);
}

/**
 * The `-n` name an orchestrate run's dashboard row is labelled with —
 * `sessionName`'s (above) counterpart for a whole project rather
 * than one item, needed because `orchestrate()` has no `BacklogItem` to
 * build that one from. Same dashboard constraint, same reason:
 * `sessionName`'s own comment explains that the dashboard's
 * `NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/` allows neither `:` nor `/`,
 * and a name that fails it is not rejected but silently dropped to
 * `undefined` — the exact failure mode `sessionName` itself was rewritten
 * once to fix, after an earlier `bl:<project>/<id>` spelling was discarded
 * on 100% of dispatches without a single request actually failing. Space-
 * separated for that reason, not the more obvious `orchestrate:<project>`.
 * Sliced to the same 60-character cap `sessionName` uses, for the same
 * reason: over the cap is the same silent drop. Exported for test/agents-prompt.test.ts, which pins the cap beside `resumeSessionName`'s.
 */
export function orchestrateSessionName(projectPath: string): string {
  return `orchestrate ${basename(projectPath)}`.slice(0, 60);
}

/**
 * `orchestrateSessionName`'s counterpart for a resumed run — same
 * `basename(projectPath)`, same 60-character cap for the same silent-drop
 * reason (see that function's own comment), and the same reason to exist at
 * all: `resume()` has no `BacklogItem` to build a name from either. The one
 * addition is the `origin` prefix, and it is the whole reason `resume()`
 * takes an `origin` parameter in the first place — the dashboard's session
 * list is the one durable trail this feature leaves behind (this app writes
 * nothing to `run.json`; see the class doc comment on `resume()`), so a row
 * reading "watchdog resume alpha" versus "resume alpha" is the only place a
 * reader can later tell "the sweeper did this while nobody was watching"
 * apart from "I clicked the button" — see the design's own §3 for why that
 * distinction is worth a name change rather than a fifth field on the
 * run-payload's `RunWatchdog`.
 *
 * The prefix-to-basename separator is a plain space, not the middle dot
 * (`·`, U+00B7) the design doc originally wrote it with. `orchestrateSessionName`
 * above already tells this story once for `:` and `/`; it applies just as
 * exactly to `·`, which is also outside `NAME_RE`'s
 * `[A-Za-z0-9][A-Za-z0-9 ._-]*` character class. A name that fails that
 * regex is not rejected — `parseSpawnRequest` on the dashboard side drops it
 * to `undefined` and the row falls back to the bare project name, silently,
 * with no failed request anywhere to notice. That is exactly the failure
 * this field exists to prevent (see the comment above): a middle-dot name
 * would make every resumed session's row indistinguishable from a
 * hand-started one, defeating `origin`'s only purpose without ever
 * producing an error. Do not "restore" the middle dot for readability — a
 * space reads fine and, unlike `·`, the dashboard actually keeps it.
 */
export function resumeSessionName(projectPath: string, origin: 'watchdog' | 'board'): string {
  const prefix = origin === 'watchdog' ? 'watchdog resume' : 'resume';
  return `${prefix} ${basename(projectPath)}`.slice(0, 60);
}

/**
 * The abort session's row name (bug-39) — `resumeSessionName`'s sibling, with
 * no `origin` because there is only one: a stop is always a person's, and
 * nothing automated ever sends one. Same `slice(0, 60)` and same plain-space
 * separator, for the reasons that function's comment gives at length.
 */
export function stopSessionName(projectPath: string): string {
  return `stop ${basename(projectPath)}`.slice(0, 60);
}
