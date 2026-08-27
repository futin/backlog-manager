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
  execute: 'backlog-manager:backlog-execute'
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
  if (item.section === 'ideas') {
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
 * The `-n` name the dashboard row is labelled with. Prefixed `bl:` so a row
 * this board started is recognisable among sessions started from a terminal.
 */
export function sessionName(item: BacklogItem): string {
  return `bl:${item.project}/${item.id}`;
}
