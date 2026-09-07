// Run files -> projects, runs and items.
//
// This module is the sweep's spine: everything else (sessions, reviews,
// drivers, totals) attaches to the rows it produces. It reads the
// run-state directory the way `orchestrator.service.ts` does — fresh, per
// call, never writing, never caching — and it is deliberately forgiving
// about what it finds there, because a historian that stops at the first
// corrupt archive reports nothing about the twenty-six good ones beside it.
import fs from 'node:fs'
import path from 'node:path'

import { RetroError } from './errors.mjs'
import { decodeProjectDir } from './paths.mjs'

// The `pending` stamp is queue wait — time the item spent waiting for the
// runner, which is not work anybody did. CLAUDE.md's own invariant on
// `itemDurationMs` states the same rule for the board ("queue wait is not
// work"), and this is that rule applied to the historian: `pending` is
// reported, separately, and never summed into pipeline time.
const QUEUE_STAGE = 'pending'

// `stageAt` -> per-stage minutes. Entries are sorted BY TIMESTAMP rather
// than by key order, because JSON key order is whatever the writer happened
// to produce and a run that re-stamped a stage out of order would otherwise
// yield negative spans.
//
// Each consecutive pair is differenced and keyed by the EARLIER stage's
// name — "how long was this item in `fixing`" is the gap between the
// `fixing` stamp and whatever came next. It follows that the terminal stamp
// (`merged`, `branched`, `parked`, …) opens no span at all, which is
// correct: nothing happened after it.
export function stageSpans(stageAt) {
  const entries = Object.entries(stageAt || {})
    .map(([stage, iso]) => [stage, Date.parse(iso)])
    .filter(([, ms]) => Number.isFinite(ms))
    .sort((a, b) => a[1] - b[1])

  const stages = {}
  let queueWaitMin = null
  for (let i = 0; i < entries.length - 1; i += 1) {
    const [stage, ms] = entries[i]
    const minutes = Math.round(((entries[i + 1][1] - ms) / 60000) * 100) / 100
    if (stage === QUEUE_STAGE) queueWaitMin = (queueWaitMin ?? 0) + minutes
    else stages[stage] = (stages[stage] ?? 0) + minutes
  }
  return { stages, queueWaitMin }
}

// Jest and tsc both colour their output, and a run file's `tail` is
// captured verbatim — so the escapes are in the stored bytes and every
// pattern below would miss without this first.
const ANSI = /\x1b\[[0-9;]*m/g

// Words that mark a line worth quoting in a report. Deliberately a small
// closed list rather than a cleverer heuristic: the point is to put three
// lines in front of a person, not to classify the failure.
const ERROR_HINTS = [/error/i, /Cannot/, /ENOENT/, /not found/, /Timeout/i, /timed out/, /exceeded/]

const MAX_TEST_NAME = 120

// A failing verification entry's tail -> the three things a report cites.
// Kept as extraction rather than judgement: it never decides WHY something
// failed, only which file, which test and which line said so.
export function verificationFailures(tail) {
  const text = String(tail || '').replace(ANSI, '')
  const files = []
  for (const m of text.matchAll(/FAIL\s+(\S+)/g)) files.push(m[1])
  const tests = []
  for (const m of text.matchAll(/●\s*(.*)$/gm)) {
    const name = m[1].trim()
    if (name) tests.push(name.length > MAX_TEST_NAME ? name.slice(0, MAX_TEST_NAME) : name)
  }
  const errors = []
  for (const line of text.split('\n')) {
    if (errors.length >= 3) break
    const trimmed = line.trim()
    if (trimmed && ERROR_HINTS.some((re) => re.test(trimmed))) errors.push(trimmed)
  }
  return { files, tests, errors }
}

// `verification` verbatim, reduced to `{cmd, ok}` plus — for a FAILING
// entry only — the extracted `failures`. Absence is the signal: a caller
// checks `'failures' in entry`, never `failures === null`, so a passing
// command can never be misread as a failure with nothing extracted.
function readVerification(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const out = { cmd: entry?.cmd ?? null, ok: entry?.ok === true }
    if (!out.ok) out.failures = verificationFailures(entry?.tail)
    return out
  })
}

function readItem(run, raw) {
  const { stages, queueWaitMin } = stageSpans(raw?.stageAt)
  return {
    runId: run.runId ?? null,
    project: run.project ?? null,
    id: raw?.id ?? null,
    title: raw?.title ?? null,
    stage: raw?.stage ?? null,
    fixLoops: Number.isFinite(raw?.fixLoops) ? raw.fixLoops : 0,
    note: raw?.note ?? null,
    permissionMode: raw?.permissionMode ?? null,
    // The stamps themselves ride along beside the derived spans: `stages`
    // cannot answer "did this item reach `dispatched`" (a terminal stamp
    // opens no span, so a dispatched-and-abandoned item has no `dispatched`
    // key), and `totals` needs preflight->terminal wall time. One extra
    // field is cheaper than re-reading the run file downstream.
    stageAt: raw?.stageAt && typeof raw.stageAt === 'object' ? raw.stageAt : {},
    stages,
    queueWaitMin,
    verification: readVerification(raw?.verification),
    // task-27's per-transcript cost, verbatim when the run recorded it.
    // Absence is a value: an older run has no `usage`, and the join falls
    // back to the item id (sessions.mjs).
    usage: Array.isArray(raw?.usage) ? raw.usage : null,
    // Filled by the session join; empty here so the shape never changes
    // between a sweep that found logs and one that did not.
    sessionKeys: [],
    verifyStatus: null,
  }
}

function readRun(file, current, raw) {
  return {
    runId: raw?.runId ?? null,
    project: raw?.project ?? null,
    status: raw?.status ?? null,
    startedAt: raw?.startedAt ?? null,
    updatedAt: raw?.updatedAt ?? null,
    mergeMode: raw?.mergeMode ?? null,
    mergeModeEffective: raw?.mergeModeEffective ?? null,
    questionMode: raw?.questionMode ?? null,
    // bug-19's driver lease. Every run before it reads `null`, which the
    // report says once rather than per run (spec §2.1).
    driverSessionId: raw?.driver?.sessionId ?? null,
    file,
    current,
    attention: Array.isArray(raw?.attention) ? raw.attention : [],
    itemCount: Array.isArray(raw?.queue) ? raw.queue.length : 0,
  }
}

// One project directory's run files, current first. An unparsable file
// prints one line on stderr and is skipped — NOT a caveat, and never fatal:
// a corrupt archive is a fact about one file, and stopping the sweep over
// it would lose every good run beside it.
function runFilesIn(dir) {
  const files = []
  const current = path.join(dir, 'run.json')
  if (fs.existsSync(current)) files.push({ file: current, current: true })
  const runsDir = path.join(dir, 'runs')
  let entries = []
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push({ file: path.join(runsDir, entry.name), current: false })
    }
  }
  return files
}

// The whole run-state home -> `{ projects, runs, items }`.
//
// `names` is the registry map; an unregistered project is swept all the
// same and labelled by its decoded path, because the registry is a
// convenience for the report and not an allowlist for the sweep.
export function readRunFiles(home, names) {
  let dirEntries
  try {
    dirEntries = fs.readdirSync(home, { withFileTypes: true })
  } catch (e) {
    // ENOENT is "no runs yet", which is an answer; anything else (a regular
    // file in the home's place, a permissions problem) is a usage error the
    // caller must see rather than read as an empty machine.
    if (e && e.code === 'ENOENT') return { projects: [], runs: [], items: [] }
    throw new RetroError(`unreadable run-state home: ${home}`, 1)
  }

  const projects = []
  const runs = []
  const items = []
  for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const project = decodeProjectDir(entry.name)
    if (project === null) continue
    const dir = path.join(home, entry.name)
    const files = runFilesIn(dir)
    // A directory with neither a `run.json` nor a `runs/` holding one is
    // skipped silently — it is litter, not a project with no history.
    if (files.length === 0) continue

    let runCount = 0
    let itemCount = 0
    for (const { file, current } of files) {
      let raw
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        console.error(`skipping unreadable run file: ${file}`)
        continue
      }
      const run = readRun(file, current, raw)
      // The run file's own `project` is authoritative where present; the
      // decoded directory name is the fallback, so a hand-copied home still
      // reports something rather than `null`.
      if (!run.project) run.project = project
      runs.push(run)
      runCount += 1
      for (const rawItem of Array.isArray(raw?.queue) ? raw.queue : []) {
        items.push(readItem(run, rawItem))
        itemCount += 1
      }
    }
    if (runCount === 0) continue
    projects.push({
      path: project,
      name: names.get(project) ?? null,
      dir: entry.name,
      runs: runCount,
      items: itemCount,
    })
  }
  return { projects, runs, items }
}
