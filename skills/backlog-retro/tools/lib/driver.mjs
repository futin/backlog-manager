// The one Claude Code transcript this tool ever opens: a run's DRIVER.
//
// The driver is the orchestrating session — the one that built the queue,
// spawned every `claude -p` child, dispatched the reviewers and did the
// merges. It is the only actor in the pipeline whose spend nothing records:
// the execute sessions write a `result` event with `total_cost_usd`, and
// the driver writes nothing about itself at all. On the 2026-09-06 hand
// sweep it came to roughly a third of the bill.
//
// It is opened by RECORDED SESSION ID (bug-19's driver lease) and never by
// a search, which is what keeps this within the spec's "no walk over
// transcripts" non-goal: one file, named by the run file itself. Every run
// from before the lease landed reads `no-lease`, and the report says that
// once rather than per run.
import fs from 'node:fs'
import path from 'node:path'

import { claudeProjectKey } from './paths.mjs'
import { priceTokens } from './rates.mjs'

// The exact tokens a dispatched subagent reported back. Claude Code puts
// this on the task-notification line the parent receives when an agent
// finishes; an agent that was dispatched and never reported leaves nothing,
// and is counted as UNMEASURED rather than as zero — it ran, so it cost
// something nobody wrote down.
const SUBAGENT_TOKENS = /<subagent_tokens>(\d+)<\/subagent_tokens>/g

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// Recursively count `Agent` tool_use blocks in an assistant message's
// content. Written against the block shape rather than a text search so a
// prompt that merely mentions the word "Agent" is never counted as one.
function countAgentBlocks(message) {
  const content = message?.content
  if (!Array.isArray(content)) return 0
  return content.filter((b) => b && b.type === 'tool_use' && b.name === 'Agent').length
}

export function readDriver(run, projectsRoot, rates) {
  const base = { runId: run.runId, project: run.project }
  if (!run.driverSessionId) return { ...base, driver: null, reason: 'no-lease' }

  const file = path.join(projectsRoot, claudeProjectKey(run.project), `${run.driverSessionId}.jsonl`)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    // Two different facts, kept apart: a transcript that was never there
    // (a run driven from another machine, or one Claude Code has pruned)
    // versus one that is there and cannot be read. Only the second is a
    // problem somebody can fix.
    return { ...base, driver: null, reason: e && e.code === 'ENOENT' ? 'not-found' : 'unreadable' }
  }

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const contexts = []
  let turns = 0
  let agentCount = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!event || event.type !== 'assistant' || !event.message) continue
    agentCount += countAgentBlocks(event.message)
    const u = event.message.usage
    if (!u) continue
    turns += 1
    tokens.input += finite(u.input_tokens)
    tokens.output += finite(u.output_tokens)
    tokens.cacheRead += finite(u.cache_read_input_tokens)
    tokens.cacheCreation += finite(u.cache_creation_input_tokens)
    // The same three fields the execute logs use for "context at this turn"
    // (sessions.mjs), so the two figures are comparable.
    contexts.push(finite(u.cache_read_input_tokens) + finite(u.cache_creation_input_tokens) + finite(u.input_tokens))
  }

  const reported = [...text.matchAll(SUBAGENT_TOKENS)].map((m) => Number(m[1]))
  const cost = priceTokens(tokens, rates)

  return {
    ...base,
    sessionId: run.driverSessionId,
    transcript: file,
    turns,
    context: contexts.length === 0
      ? null
      : {
        avg: Math.round(contexts.reduce((a, b) => a + b, 0) / contexts.length),
        max: Math.max(...contexts),
      },
    tokens,
    subagents: {
      count: agentCount,
      tokens: reported.reduce((a, b) => a + b, 0),
      unmeasured: Math.max(0, agentCount - reported.length),
    },
    // `null` when there is no fit — the tokens are still measured, only the
    // dollars are unknown, and an unpriced driver is unknown spend rather
    // than free spend.
    estimatedCostUsd: cost,
    // Present on every measured driver, always, so no caller can print this
    // figure without having had the chance to mark it (spec 3.6).
    estimated: true,
    driver: run.driverSessionId,
  }
}
