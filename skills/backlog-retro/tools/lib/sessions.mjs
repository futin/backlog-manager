// Headless session transcripts -> `sessions[]`, and the join that attaches
// them to the items they executed.
//
// These are the `--output-format stream-json` logs `backlog-orchestrate`
// redirects each `claude -p` child into, not Claude Code's own transcripts:
// the tool never opens an execute transcript (spec 3.6), because the log
// already carries a `result` event with the cost the CLI actually billed.
// The one Claude Code transcript this tool opens is a run's DRIVER, and
// that lives in driver.mjs.
import fs from 'node:fs'
import path from 'node:path'

import { sidecarFiles } from './paths.mjs'

// `<id>.jsonl` | `<id>-fix-<n>.jsonl` | `<id>-retry-<n>.jsonl`, and nothing
// else. The FILE NAME is the only thing that can classify these: `claude -p
// --resume` keeps the session id it was handed, so an item's execute
// transcript and its fix loop's report the same `session_id` (task-27's own
// note on `RunSessionUsage.sessionId`, verified on this machine's task-22
// pair). `null` for `.err`, `.pid` and anything else in the directory —
// deliberately strict, because a silent default of `execute` would file a
// stray file's cost against a real item forever.
const LOG_NAME = /^([a-z]+-\d+)(?:-(fix|retry)-(\d+))?\.jsonl$/

export function classifyLog(basename) {
  const m = LOG_NAME.exec(basename)
  if (!m) return null
  return { itemId: m[1], kind: m[2] ?? 'execute', loop: m[3] === undefined ? null : Number(m[3]) }
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// The first three context samples are where `floor` comes from, not the
// whole session: a session's floor is what it costs to say ANYTHING once
// the system prompt, CLAUDE.md, the skill and the memory index have loaded
// — the standing toll on every later turn. Taking the minimum over the
// whole run would just report turn one, before the skill was even read.
const FLOOR_SAMPLES = 3

// One transcript -> one `session` row. Read line by line and forgiving of
// junk: these files are appended by a live child process, so a truncated
// final line and an interleaved hook event are both normal.
export function readSession(file, meta) {
  const text = fs.readFileSync(file, 'utf8')
  let result = null
  let initSessionId = null
  const contexts = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    if (event.type === 'system' && event.subtype === 'init' && initSessionId === null
      && typeof event.session_id === 'string') {
      initSessionId = event.session_id
    }
    if (event.type === 'assistant' && event.message && event.message.usage) {
      const u = event.message.usage
      contexts.push(
        (finiteOrNull(u.cache_read_input_tokens) ?? 0)
        + (finiteOrNull(u.cache_creation_input_tokens) ?? 0)
        + (finiteOrNull(u.input_tokens) ?? 0),
      )
    }
    // LAST result event wins: a resumed session appends a second one, and
    // the last is the one that describes how the transcript actually ended.
    if (event.type === 'result') result = event
  }

  return {
    key: null,
    project: meta?.project ?? null,
    itemId: meta?.itemId ?? null,
    runId: null,
    kind: meta?.kind ?? null,
    loop: meta?.loop ?? null,
    file,
    sessionId: (result && typeof result.session_id === 'string' ? result.session_id : null) ?? initSessionId,
    result: result === null ? null : readResult(result),
    context: contexts.length === 0
      ? null
      : {
        floor: Math.min(...contexts.slice(0, FLOOR_SAMPLES)),
        peak: Math.max(...contexts),
        messages: contexts.length,
      },
    joinedBy: 'none',
  }
}

function readResult(result) {
  const usage = result.usage && typeof result.usage === 'object' ? result.usage : {}
  const models = result.modelUsage && typeof result.modelUsage === 'object'
    ? Object.keys(result.modelUsage)
    : []
  return {
    costUsd: finiteOrNull(result.total_cost_usd),
    turns: finiteOrNull(result.num_turns),
    durationMs: finiteOrNull(result.duration_ms),
    input: finiteOrNull(usage.input_tokens),
    output: finiteOrNull(usage.output_tokens),
    cacheRead: finiteOrNull(usage.cache_read_input_tokens),
    cacheCreation: finiteOrNull(usage.cache_creation_input_tokens),
    denials: Array.isArray(result.permission_denials) ? result.permission_denials.length : 0,
    // Three outcomes, not two: a spend limit is the run hitting a wall it
    // will hit again tomorrow, and an API error is weather. Folding them
    // together would hide the only one worth acting on.
    terminated: terminationOf(result),
    model: models.length === 0 ? null : models.join(','),
  }
}

function terminationOf(result) {
  if (!result.is_error) return 'ok'
  return /spend limit/i.test(String(result.result ?? '')) ? 'spend-limit' : 'error'
}

// Every transcript under one project's run state, live and archived alike.
export function readSessions(projectDirPath, project) {
  const sessions = []
  for (const { file, rel, name } of sidecarFiles(projectDirPath, 'logs')) {
    const meta = classifyLog(name)
    if (!meta) continue
    let session
    try {
      session = readSession(file, { ...meta, project })
    } catch {
      console.error(`skipping unreadable transcript: ${file}`)
      continue
    }
    // The key is the path relative to the PROJECT, not the basename: two
    // archives can each hold a `bug-1.jsonl`, and a bare basename would
    // collapse two real sessions into one row.
    session.key = `${project}/${rel.split(path.sep).join('/')}`
    sessions.push(session)
  }
  return sessions
}

// Which run a transcript belongs to.
//
// The sidecar directories are keyed by item id and nothing else, so an item
// two runs dispatched has ONE transcript name with two candidate owners.
// The rule is the latest run that actually dispatched it — a later run's
// session overwrote the earlier one's file, so the surviving bytes are the
// later run's — and the ambiguity is reported rather than hidden, because a
// reader who sees a $6 session against a run that never ran it deserves to
// know why.
function dispatchIndex(items) {
  const index = new Map()
  for (const item of items) {
    if (!item.stageAt || item.stageAt.dispatched === undefined) continue
    const key = `${item.project} ${item.id}`
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(item)
  }
  return index
}

// A usage entry's identity is `kind` + `loop`, NOT its session id — three
// transcripts of one item all report the same session id (task-27's own
// note on RunSessionUsage.sessionId), so a sessionId match would attach a
// fix loop's log to the execute session's entry. The session id is used to
// CORROBORATE the match, never to make it.
function matchUsage(item, session) {
  if (!Array.isArray(item.usage)) return null
  return item.usage.find((u) => u
    && u.kind === session.kind
    && (u.loop ?? null) === (session.loop ?? null)) ?? null
}

export function attachSessions(items, sessions, runsById) {
  const caveats = []
  const index = dispatchIndex(items)
  const collisionsReported = new Set()

  for (const session of sessions) {
    if (session.result === null) {
      caveats.push({
        kind: 'killed',
        detail: `no result event in ${session.key} — the session was killed or is still running; its cost is not measured`,
      })
    }

    const key = `${session.project} ${session.itemId}`
    const candidates = index.get(key) ?? []
    if (candidates.length === 0) {
      // `joinedBy: 'none'` and `runId: null` — reported, never dropped. A
      // transcript with no run is usually a run file that was pruned, and
      // its cost is still real money this machine spent.
      continue
    }
    const chosen = candidates
      .slice()
      .sort((a, b) => startedMs(runsById, a) - startedMs(runsById, b))
      .at(-1)
    session.runId = chosen.runId
    chosen.sessionKeys.push(session.key)

    if (candidates.length > 1 && !collisionsReported.has(key)) {
      collisionsReported.add(key)
      const ids = candidates.map((c) => c.runId).join(', ')
      caveats.push({
        kind: 'collision',
        detail: `${session.project} ${session.itemId} was dispatched by more than one run (${ids}); its transcripts are attributed to ${chosen.runId}, the latest`,
      })
    }

    const usage = matchUsage(chosen, session)
    if (usage) {
      session.joinedBy = 'usage'
      if (session.result) {
        const diffs = []
        if (usage.costUsd !== null && usage.costUsd !== undefined && session.result.costUsd !== null
          && Math.abs(usage.costUsd - session.result.costUsd) > 1e-9) {
          diffs.push(`costUsd ${usage.costUsd} vs ${session.result.costUsd}`)
        }
        if (usage.turns !== null && usage.turns !== undefined && session.result.turns !== null
          && usage.turns !== session.result.turns) {
          diffs.push(`turns ${usage.turns} vs ${session.result.turns}`)
        }
        if (diffs.length > 0) {
          // The run file wins, always. It is the archive that outlives the
          // log directory, and a historian that silently preferred the
          // shorter-lived copy would report different numbers next month.
          caveats.push({
            kind: 'usage-mismatch',
            detail: `${session.key} disagrees with the run file's usage entry (${diffs.join('; ')}); the run file's values are kept`,
          })
        }
      }
    } else {
      session.joinedBy = 'item'
    }
  }
  return caveats
}

// Run ids are minted from a UTC clock (`run-YYYYMMDD-HHMMSS`), so two
// projects swept on the same second genuinely can share one — the index is
// keyed by project AND id for that reason, never by id alone.
export function runKey(project, runId) {
  return `${project} ${runId}`
}

function startedMs(runsById, item) {
  const run = runsById.get(runKey(item.project, item.runId))
  const ms = Date.parse(run?.startedAt ?? '')
  return Number.isFinite(ms) ? ms : 0
}
