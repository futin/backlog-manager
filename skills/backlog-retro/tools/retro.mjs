#!/usr/bin/env node
// retro: the measurement half of `backlog-retro`. This tool sweeps every
// orchestrator run this machine has produced — run files, headless session
// logs, reviewer reports, verify statuses and, where a run recorded a
// driver lease, the orchestrating session's own transcript — into ONE
// deterministic JSON object, and owns exactly one directory,
// `~/.backlog-manager/retro/`, whose only writer is `record`.
//
// The division of labour is the whole design (spec §7): the tool computes
// what is arithmetic and the SESSION judges what is not. Cost per merged
// item, stage durations, fix-loop rate, context floor and peak are the
// same number every time they are derived; whether a reviewer's Important
// finding was prose drift, a test that could not fail, or a real defect is
// not, and no amount of regex will make it so. So `sweep` never labels and
// `record` refuses a label outside the closed set.
//
//   node "$CLAUDE_PLUGIN_ROOT/skills/backlog-retro/tools/retro.mjs" sweep --json
//   node "$CLAUDE_PLUGIN_ROOT/skills/backlog-retro/tools/retro.mjs" last
//
// Deliberately standalone, exactly as orchestrate.mjs is: it imports
// nothing from another skill's `tools/` and nothing from the server, even
// where a helper below is a close cousin of one that already exists there.
// See lib/paths.mjs's header for why the duplication is the rule.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RetroError } from './lib/errors.mjs'
import {
  claudeProjectsRoot, orchHome, projectDir, readRegistryNames, registryFile, retroHome,
} from './lib/paths.mjs'
import { readRunFiles } from './lib/run-files.mjs'
import { readDriver } from './lib/driver.mjs'
import { readReviews, readVerifyStatus } from './lib/reviews.mjs'
import { fitRates } from './lib/rates.mjs'
import { attachSessions, readSessions, runKey } from './lib/sessions.mjs'
import { renderText } from './lib/text.mjs'
import { computePrevious, computeTotals, LABELS, newestRecord } from './lib/totals.mjs'

// --- errors -------------------------------------------------------------
// `RetroError` itself lives in lib/errors.mjs so the lib modules can throw
// it without importing this file back; it is re-exported here so the CLI's
// public surface is unchanged. Its `code` IS the process exit status.
//
// The contract, quoted by SKILL.md and by every test below:
//   0  success — including a sweep of an empty home, because `runs: []` is
//      an answer and not a failure.
//   1  usage error, an unreadable home, an unknown --project, or a `record`
//      whose input is missing, unparsable or carries a label/status outside
//      its closed set.
//   2  `record` refuses to overwrite an existing record. Its own number
//      rather than a 1 because the reaction is not "fix this call and
//      retry" — a record is evidence, and the fix for a wrong one is a new
//      sweep, never an edit.
//   3  `last` found no record yet. The same "nothing exists" code
//      orchestrate.mjs's `status` uses, for the same reason.
// Every non-zero exit prints one line on stderr and writes nothing.
export { RetroError }

const USAGE = `usage: retro.mjs <command> [options]

  sweep [--json | --text] [--project <abs path>] [--home <dir>]
      Read every project's run state and print one RetroSweep object.
      --json is the default; --text renders the same facts as tables.

  record --sweep <sweep.json> --labels <labels.json> --report <report.md> [--home <dir>]
      Write <retroHome>/<generatedAt>.json and copy the report beside it.
      Refuses to overwrite an existing record (exit 2).

  last [--home <dir>]
      Print the newest record's path, or exit 3 when there is none yet.

Homes, each overridable so a test never touches real state:
  $BM_ORCH_HOME        run state   (default ~/.backlog-manager/orchestrator)
  $BM_RETRO_HOME       records     (default ~/.backlog-manager/retro)
  $BM_REGISTRY_FILE    project names (default ~/.backlog-manager/registry.json)
  $BM_CLAUDE_PROJECTS  driver transcripts (default ~/.claude/projects)`

// --- flag parsing --------------------------------------------------------
// One tiny parser for all three commands: `--flag value` pairs plus bare
// switches. Unknown flags are a usage error rather than silently ignored,
// because a mistyped `--porject` that swept everything would be reported as
// a fact about the whole machine.
function parseArgs(rest, { switches = [], values = [] }) {
  const out = { _: [] }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (switches.includes(arg)) {
      out[arg.replace(/^--/, '')] = true
    } else if (values.includes(arg)) {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new RetroError(`${arg} needs a value\n\n${USAGE}`, 1)
      }
      out[arg.replace(/^--/, '')] = value
      i += 1
    } else if (arg.startsWith('--')) {
      throw new RetroError(`unknown option: ${arg}\n\n${USAGE}`, 1)
    } else {
      out._.push(arg)
    }
  }
  return out
}

// `--home` overrides $BM_ORCH_HOME for one call, so a person can point the
// sweep at a copy of somebody else's run state without exporting anything.
function resolveHome(flags) {
  return flags.home ? path.resolve(flags.home) : orchHome()
}

function cmdSweep(rest) {
  const flags = parseArgs(rest, { switches: ['--json', '--text'], values: ['--project', '--home'] })
  if (flags.json && flags.text) throw new RetroError(`--json and --text are exclusive\n\n${USAGE}`, 1)
  return runSweep({
    home: resolveHome(flags),
    project: flags.project ? path.resolve(flags.project) : null,
    text: Boolean(flags.text),
  })
}

function cmdRecord(rest) {
  const flags = parseArgs(rest, { switches: [], values: ['--sweep', '--labels', '--report', '--home'] })
  return runRecord(flags)
}

function cmdLast(rest) {
  const flags = parseArgs(rest, { switches: [], values: ['--home'] })
  return runLast(flags.home ? path.resolve(flags.home) : retroHome())
}

// The three notes a reader needs before quoting a dollar figure or a
// context number derived above.
//
// `no-lease` carries a COUNT rather than one entry per run, and that is the
// point: every run from before bug-19's driver lease landed lacks one, so
// per-run entries would be the majority of the list and would drown every
// other caveat in it.
const LONG_CONTEXT_TOKENS = 200000

function rateCaveats(rates, drivers, sessions) {
  const out = []
  const noLease = drivers.filter((d) => d.driver === null && d.reason === 'no-lease').length
  if (noLease > 0) {
    out.push({
      kind: 'no-lease',
      detail: `${noLease} run(s) recorded no driver lease (every run predating bug-19); their orchestrating sessions are unmeasured, not free`,
    })
  }
  if (rates === null) {
    out.push({
      kind: 'rates',
      detail: 'fewer than 8 measured sessions, so no per-token rates were fitted; every driver stays in tokens and no all-in figure is reported',
    })
  } else {
    out.push({
      kind: 'rates',
      detail: `per-token rates fitted over ${rates.sessions} measured sessions, max residual $${rates.maxResidualUsd.toFixed(2)}; the long-context tier is not modelled`,
    })
  }
  const long = sessions.filter((s) => s.context && s.context.peak > LONG_CONTEXT_TOKENS)
  if (long.length > 0) {
    // Named, but capped: on this machine 37 sessions cross the tier, and a
    // caveat that printed all 37 paths would be longer than the report it
    // is a footnote to. The count is the fact; the names are the lead.
    const named = long.slice(0, 5).map((s) => s.key)
    const more = long.length - named.length
    out.push({
      kind: 'long-context',
      detail: `${long.length} session(s) peaked above ${LONG_CONTEXT_TOKENS} tokens and were billed at a tier the rate fit does not model: `
        + `${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}`,
    })
  }
  return out
}

// One sweep: every project's run state read once, one object out.
//
// The object's shape is fixed even when a half of it is empty, so the skill
// (and every test) can read `sweep.rates` or `sweep.previous` without first
// asking whether this build filled it. `null` means "not derivable here",
// never "zero" — a distinction the whole report depends on.
function buildSweep({ home, project }) {
  const names = readRegistryNames(registryFile())
  const all = readRunFiles(home, names)

  // `--project` scopes every array to one path. The refusal is deliberate
  // and comes BEFORE any filtering: a typo'd path that silently swept
  // nothing would print a report full of zeroes about a machine that is
  // perfectly busy.
  if (project !== null && !all.projects.some((p) => p.path === project)) {
    throw new RetroError(`no run state for ${project}`, 1)
  }
  const keep = (row) => project === null || row.project === project
  const projects = project === null ? all.projects : all.projects.filter((p) => p.path === project)
  const runs = all.runs.filter(keep)
  const items = all.items.filter(keep)

  // The join needs every run's `startedAt` by (project, run id) — see
  // sessions.mjs's `runKey` for why the project is part of the key.
  const runsByKey = new Map(runs.map((r) => [runKey(r.project, r.runId), r]))
  const sessions = []
  const reviews = []
  for (const p of projects) {
    const dir = projectDir(home, p.path)
    sessions.push(...readSessions(dir, p.path))
    reviews.push(...readReviews(dir, p.path))
  }
  const caveats = attachSessions(items, sessions, runsByKey)

  // The verify status rides on the ITEM rather than in an array of its own:
  // there is exactly one per item, and every question anybody asks of it
  // ("did the thing the run merged actually prove itself") is a question
  // about that item.
  for (const item of items) {
    item.verifyStatus = readVerifyStatus(projectDir(home, item.project), item.id)
  }

  // Rates before drivers, because a driver's dollars are priced with them;
  // both before totals, because totals fold what the drivers produced.
  const rates = fitRates(sessions)
  const drivers = runs.map((r) => readDriver(r, claudeProjectsRoot(), rates))
  caveats.push(...rateCaveats(rates, drivers, sessions))

  const sweep = {
    generatedAt: new Date().toISOString(),
    home,
    retroHome: retroHome(),
    projects,
    runs,
    items,
    sessions,
    reviews,
    drivers,
    rates,
    totals: null,
    previous: null,
    caveats,
    scope: project,
  }
  // Totals last, and over the finished object: every number in them comes
  // from the rows above and never from a second read of the filesystem, so
  // a sweep and its own totals can never disagree.
  sweep.totals = computeTotals(sweep)
  // The ONE place `sweep` opens the retro home, and it opens it READ-ONLY.
  // `record` stays that directory's only writer (CLAUDE.md's invariant).
  sweep.previous = computePrevious(sweep, newestRecord(retroHome()))
  return sweep
}

function runSweep({ home, project, text }) {
  const sweep = buildSweep({ home, project })
  process.stdout.write(text ? renderText(sweep) : `${JSON.stringify(sweep, null, 2)}\n`)
  return 0
}

// --- record --------------------------------------------------------------

// The three statuses a candidate can end a retro in. `declined` is a real
// outcome and is recorded on purpose: the next sweep reads it and does not
// propose the same thing again (spec 3.4).
const CANDIDATE_STATUSES = ['filed', 'declined', 'deferred']
const CANDIDATE_KINDS = ['bug', 'task', 'idea']

function readJsonInput(file, flag) {
  if (!file) throw new RetroError(`${flag} is required\n\n${USAGE}`, 1)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw new RetroError(`cannot read ${flag} ${file}`, 1)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new RetroError(`${flag} ${file} is not valid JSON`, 1)
  }
}

// Validation exists so a typo cannot become a fifth category the next sweep
// counts. It runs BEFORE anything is written and names the FIRST offending
// key, because a session that has to guess which of forty labels was wrong
// will re-run the whole retro rather than look.
function validateLabels(labels) {
  if (!labels || typeof labels !== 'object') throw new RetroError('labels must be an object', 1)
  const reviews = labels.reviews ?? {}
  if (typeof reviews !== 'object' || Array.isArray(reviews)) {
    throw new RetroError('labels.reviews must be an object keyed by review file', 1)
  }
  for (const [key, value] of Object.entries(reviews)) {
    if (!LABELS.includes(value)) {
      throw new RetroError(`labels.reviews["${key}"] is "${value}", not one of ${LABELS.join(' | ')}`, 1)
    }
  }
  const candidates = labels.candidates ?? []
  if (!Array.isArray(candidates)) throw new RetroError('labels.candidates must be an array', 1)
  candidates.forEach((c, i) => {
    const at = `labels.candidates[${i}]`
    if (!c || typeof c !== 'object') throw new RetroError(`${at} is not an object`, 1)
    if (typeof c.title !== 'string' || c.title === '') throw new RetroError(`${at}.title must be a non-empty string`, 1)
    if (!CANDIDATE_KINDS.includes(c.kind)) {
      throw new RetroError(`${at}.kind is "${c.kind}", not one of ${CANDIDATE_KINDS.join(' | ')}`, 1)
    }
    if (typeof c.project !== 'string' || c.project === '') throw new RetroError(`${at}.project must be a non-empty string`, 1)
    if (!CANDIDATE_STATUSES.includes(c.status)) {
      throw new RetroError(`${at}.status is "${c.status}", not one of ${CANDIDATE_STATUSES.join(' | ')}`, 1)
    }
  })
}

// The record's file name. Every `:` and `.` in the sweep's own
// `generatedAt` becomes a `-`, which is what makes an ISO stamp a legal
// path segment on every filesystem — and leaves the stems lexically
// ordered, so `last` and `newestRecord` sort rather than parse.
function recordStem(generatedAt) {
  if (typeof generatedAt !== 'string' || generatedAt === '') {
    throw new RetroError('the sweep file has no generatedAt', 1)
  }
  return generatedAt.replace(/[:.]/g, '-')
}

function runRecord(flags) {
  const home = flags.home ? path.resolve(flags.home) : retroHome()
  const sweep = readJsonInput(flags.sweep, '--sweep')
  const labels = readJsonInput(flags.labels, '--labels')
  if (!flags.report) throw new RetroError(`--report is required\n\n${USAGE}`, 1)
  let report
  try {
    report = fs.readFileSync(flags.report)
  } catch {
    throw new RetroError(`cannot read --report ${flags.report}`, 1)
  }
  validateLabels(labels)

  const stem = recordStem(sweep.generatedAt)
  const jsonPath = path.join(home, `${stem}.json`)
  const mdPath = path.join(home, `${stem}.md`)
  // Refusal before creation, so a refused record leaves the home exactly as
  // it found it — including not existing.
  if (fs.existsSync(jsonPath)) throw new RetroError(`record exists: ${jsonPath}`, 2)
  fs.mkdirSync(home, { recursive: true })

  const body = {
    sweep,
    // Kept SEPARATE from the sweep, in their own key, because they are the
    // one place judgment enters the record and a later reader has to be
    // able to tell the arithmetic from the reading of it.
    labels,
    recordedBy: process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
  }
  // Write-to-temp-then-rename: a record half-written by an interrupted
  // session would be evidence of nothing, and `newestRecord` would pick it.
  const tmp = path.join(home, `.${stem}.json.tmp`)
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`)
  fs.renameSync(tmp, jsonPath)
  fs.writeFileSync(mdPath, report)

  process.stdout.write(`${JSON.stringify({ record: jsonPath, report: mdPath }, null, 2)}\n`)
  return 0
}

function runLast(home) {
  const newest = newestRecord(home)
  // Exit 3 is "nothing exists yet", the same code orchestrate.mjs's
  // `status` uses for the same question — a first retro on a machine is not
  // an error, and a caller scripting around it should be able to tell the
  // two apart without reading stderr.
  if (newest === null) throw new RetroError('no record yet', 3)
  process.stdout.write(`${newest.file}\n`)
  return 0
}

export function main(argv) {
  const [cmd, ...rest] = argv
  try {
    if (cmd === 'sweep') return cmdSweep(rest)
    if (cmd === 'record') return cmdRecord(rest)
    if (cmd === 'last') return cmdLast(rest)
    if (cmd === undefined) {
      console.error(USAGE)
      return 1
    }
    console.error(`unknown command: ${cmd}\n\n${USAGE}`)
    return 1
  } catch (e) {
    if (!(e instanceof RetroError)) throw e
    console.error(e.message)
    return e.code
  }
}

// Guarded the same way orchestrate.mjs guards its own entry point, so the
// test suite can import `main` and `RetroError` without the module running
// a sweep as a side effect of being loaded.
//
// `process.exitCode`, NOT `process.exit()`, and the difference is a bug this
// tool actually shipped for an afternoon. `process.stdout.write` to a PIPE is
// asynchronous, and `process.exit()` tears the process down without draining
// it — so everything past the 64KB pipe buffer is silently dropped. A real
// sweep of this machine is 442,757 bytes; through `| jq` it arrived as
// exactly 65,536 and a parse error, while `> file.json` (a synchronous write
// on POSIX) was perfectly fine, which is precisely the shape of bug that
// survives every hand check. Setting the code instead lets node flush and
// exit on its own. Nothing here holds the event loop open — every read is
// synchronous `fs` and there is no server, no timer and no child process —
// so "exit naturally" is not a hang waiting to happen.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}

// Re-exported so the CLI's own contract (which homes it reads) is visible
// from one import in tests and in later tasks' modules.
export { orchHome, retroHome, registryFile, claudeProjectsRoot }
