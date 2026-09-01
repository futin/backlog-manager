import type { AgentAction } from '../../../shared/agent';
import type { BacklogItem } from '../../../shared/types';

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

/**
 * Titles come from item frontmatter, which is a `key: value` line — so a
 * newline cannot legally be in one. Collapsed anyway: this string is piped to
 * a child process as a prompt, and a hand-edited file is exactly the input
 * that would otherwise turn one instruction into two.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function composePrompt(item: BacklogItem, action: AgentAction): string {
  const head = `Use the ${SKILL[action]} skill on ${item.id} — "${oneLine(item.title)}" — in this repo's backlog.`;

  if (action === 'execute') {
    // "verify" and "archive" are the two halves backlog-execute refuses to
    // separate, and the commit ban is belt-and-braces: the skill already says
    // it never commits, but this session has no human at a terminal to stop it
    // if it decides to be helpful.
    return `${head} Work it through to verification, then archive the item. Report what you changed; do not commit or push.`;
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
    return `${head} It was ruled out of scope. File a NEW item that revives it, and give that new item a from: ${item.id} line in its frontmatter — either by passing --from ${item.id} to the backlog tool's new command, or by writing that line into the frontmatter by hand the way a tags: line is added. The citation is required: it is the revived item's only link back to the rejection. Leave ${item.id} itself exactly where it is — the rejection stays on the record.`;
  }
  // Refactors share this branch, not the fallback at the bottom: grooming one
  // promotes it into a task exactly as grooming an idea does, so the
  // instruction is the same sentence. Without this they fell through to the
  // task fallback ("give it a plan") — which reads as an instruction to edit
  // the refactor in place, the one thing a promote must not do.
  if (item.section === 'ideas' || item.section === 'refactors') {
    return `${head} Promote it to a task with a real, executable plan.`;
  }
  if (item.section === 'bugs') {
    // "Leave the item in bugs/open/" is the whole difference between grooming a
    // bug and executing it: groom fills the two headings and moves nothing.
    return `${head} Investigate it and fill in ## Cause and ## Fix. Leave the item in bugs/open/.`;
  }
  // A task with no Plan — only reachable from a hand-made file, since
  // backlog-capture refuses to create one without.
  return `${head} Give it a plan concrete enough to execute.`;
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
