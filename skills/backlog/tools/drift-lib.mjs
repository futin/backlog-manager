// Groom drift (#322): the anchor a plan was written against, and how far the base has moved under the paths that plan names since.
//
// TWO BYTE-IDENTICAL COPIES of this file ship: `skills/backlog/tools/drift-lib.mjs` and `skills/backlog-orchestrate/tools/drift-lib.mjs`.
// `orchestrate.mjs` is deliberately standalone — its header says it imports nothing from `skills/backlog/tools/`, because a static import that cannot be
// resolved fails the WHOLE module at load, and a run whose every command dies over a drift preview is a far worse failure than a stale copy. So each tool
// imports the copy beside it, and `drift-lib.test.mjs` asserts the two files are identical and runs every case against both. Edit one, copy it over.
//
// Every git call is `spawnSync`, on purpose: these are skill CLIs that exit through `process.exitCode`, and a spawnSync child is reaped before the call
// returns. The server's "never spawn git synchronously" invariant is about request paths in a long-lived process and does not apply here.
//
// Nothing here is stored. `groomed-at` is written by `backlog.mjs` (frontmatter, or the tracker body footer below); drift is derived per call from it.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// The tracker half of the anchor: an HTML comment on the body's own last line, which the board's markdown renderer draws as nothing. Matched anywhere in
// the body (multiline), so a footer a hand edit moved up is still found and still replaced rather than duplicated.
const FOOTER_LINE = /^<!-- bm:groomed-at ([0-9a-f]{7,64}) -->[ \t]*$/m
const FOOTER_LINES = /^<!-- bm:groomed-at [0-9a-f]{7,64} -->[ \t]*$/gm

/** The sha a tracker body's `bm:groomed-at` footer names, or `null`. */
export function parseGroomedAtFooter(body) {
  const m = FOOTER_LINE.exec(typeof body === 'string' ? body : '')
  return m === null ? null : m[1]
}

/**
 * The body with every `bm:groomed-at` footer line removed, CRLF normalised to LF and trailing whitespace trimmed. Applied before ANY section is read for
 * drift or hashing: when `## Plan` is the body's last heading, `extractSection` would otherwise carry the footer inside the plan, and a re-stamp alone would
 * change the plan's hash and its path list.
 */
export function stripGroomedAtFooter(body) {
  return (typeof body === 'string' ? body : '').replace(/\r\n/g, '\n').replace(FOOTER_LINES, '').replace(/\s+$/, '')
}

/** The body with exactly one footer naming `sha`, on its own last line. An existing footer is replaced, never appended to. */
export function stampGroomedAt(body, sha) {
  const stripped = stripGroomedAtFooter(body)
  return `${stripped}${stripped === '' ? '' : '\n\n'}<!-- bm:groomed-at ${sha} -->\n`
}

/** `git rev-parse HEAD` in `root`, or `null` when git cannot answer (not a repo, or a repo with no commits). Never throws. */
export function headSha(root) {
  const out = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { encoding: 'utf8' })
  if (out.status !== 0) return null
  const sha = out.stdout.trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

/**
 * One `## <heading>` section's content: from the line after the heading to the next `## ` line, or the end. `undefined` when the heading is absent — kept
 * apart from `''`, the same distinction `orchestrate.mjs`'s own `extractSection` keeps for its gate.
 */
export function extractSection(body, heading) {
  const lines = body.split('\n')
  const idx = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (idx === -1) return undefined
  const rest = lines.slice(idx + 1)
  const end = rest.findIndex((l) => l.trimStart().startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** The section the gate reads for this item: `## Plan` for a task, `## Fix` for a bug. Footer stripped, CRLF normalised. `undefined` for any other section. */
export function planSection(body, section) {
  const heading = section === 'tasks' ? 'Plan' : section === 'bugs' ? 'Fix' : null
  if (heading === null) return undefined
  return extractSection(stripGroomedAtFooter(body), heading)
}

/**
 * sha256 of a plan's text, trimmed and with CRLF normalised — the key a stale-plan mark is filed under. A re-groom that changes the text changes the hash,
 * which is the whole of how a mark is cleared; a CRLF→LF rewrite of the same words does not, because nobody re-groomed anything.
 */
export function planHash(text) {
  return createHash('sha256')
    .update(String(text ?? '').replace(/\r\n/g, '\n').trim())
    .digest('hex')
}

// A token "looks like a path" when it holds a `/` or ends in a file extension. The extension must start with a letter, so `v1.2` and `0.5` stay numbers.
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]*$/
const LINE_SUFFIX = /:\d+(?::\d+)?$/

/**
 * Backtick-quoted tokens in `text` that look like paths, `:line` / `:line:col` stripped, a leading `./` and trailing `/` removed, in first-seen order and
 * deduplicated. This is only the SHAPE test: `planDrift` then keeps a token only if git knows it at the anchor or the base, which is what drops a command line
 * such as `node skills/x/y.mjs drift <id>` that happens to contain a slash.
 */
export function pathTokens(text) {
  const seen = new Set()
  const out = []
  for (const m of String(text ?? '').matchAll(/`([^`\n]+)`/g)) {
    let token = m[1].trim().replace(LINE_SUFFIX, '')
    if (!(token.includes('/') || EXTENSION.test(token))) continue
    token = token.replace(/^\.\//, '').replace(/\/+$/, '')
    if (token === '' || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function resolveCommit(root, ref) {
  const out = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return out.status === 0 ? out.stdout.trim() : null
}

// Every file and directory in one commit's tree, from one `ls-tree` rather than one `cat-file -e` per token per ref. Memoised by commit sha, which is safe
// for a process's lifetime because a commit's tree never changes.
const treeCache = new Map()
function treeOf(root, commit) {
  const key = `${root}\0${commit}`
  const cached = treeCache.get(key)
  if (cached !== undefined) return cached
  const listed = git(root, ['ls-tree', '-r', '-t', '--name-only', '-z', commit])
  const names = new Set(listed.status === 0 ? listed.stdout.split('\0').filter((n) => n !== '') : [])
  treeCache.set(key, names)
  return names
}

// A files `created:` is a bare `YYYY-MM-DD`. git's approxidate does NOT read that as the start of the day — it fills in the CURRENT time of day — so the
// anchor would move with the clock the command runs under. Pinned to UTC midnight here, which is what the plan meant and what a test can assert.
function gitDate(created) {
  return /^\d{4}-\d{2}-\d{2}$/.test(created) ? `${created}T00:00:00Z` : created
}

function unknown(reason, anchor = null, anchorSource = null) {
  return { status: 'unknown', anchor, anchorSource, commits: 0, paths: [], reason }
}

/**
 * How far `base` has moved under the paths an item's plan names, since the commit the plan was written against.
 *
 *   projectRoot  the git work tree to ask
 *   body         the item's body (a tracker footer, if any, is stripped here)
 *   frontmatter  `{ 'groomed-at'?, created? }` — a tracker caller parses the footer into this same shape
 *   section      `tasks` (reads `## Plan`) or `bugs` (reads `## Fix`)
 *   base         the ref drift is measured to
 *
 * The anchor is `groomed-at` when that commit exists here (or its merge-base with `base`, when it is not an ancestor), else the last commit on `base` before
 * `created:`, else nothing. `created` over-counts drift for an item re-groomed after capture, and that is the safe direction: a later fallback (a tracker
 * `updated`, a file's last commit) moves after the groom — heartbeats, claim comments, stop stamps — and would miss real drift.
 *
 * Returns `{ status: 'none'|'drifted'|'unknown', anchor, anchorSource: 'groomed-at'|'created'|null, commits, paths: [{ path, commits, missing }], reason }`.
 * `commits` is DISTINCT across all kept paths, never a sum. `reason` is a sentence for `unknown` and `null` otherwise.
 */
export function planDrift({ projectRoot, body, frontmatter = {}, section, base = 'HEAD' }) {
  const text = planSection(body, section)
  if (text === undefined || text.trim() === '' || text.trim() === 'unknown') {
    return unknown(`no ${section === 'bugs' ? '## Fix' : '## Plan'} to measure`)
  }

  const baseSha = resolveCommit(projectRoot, base)
  if (baseSha === null) return unknown(`base ${base} does not resolve in this repository`)

  let anchor = null
  let anchorSource = null
  const groomedAt = typeof frontmatter['groomed-at'] === 'string' ? frontmatter['groomed-at'].trim() : ''
  if (groomedAt !== '') {
    const sha = resolveCommit(projectRoot, groomedAt)
    if (sha !== null) {
      if (git(projectRoot, ['merge-base', '--is-ancestor', sha, baseSha]).status === 0) {
        anchor = sha
      } else {
        const mb = git(projectRoot, ['merge-base', sha, baseSha])
        if (mb.status === 0 && mb.stdout.trim() !== '') anchor = mb.stdout.trim()
      }
      if (anchor !== null) anchorSource = 'groomed-at'
    }
  }
  const created = typeof frontmatter.created === 'string' ? frontmatter.created.trim() : ''
  if (anchor === null && created !== '') {
    const before = git(projectRoot, ['rev-list', '-1', `--before=${gitDate(created)}`, baseSha])
    if (before.status === 0 && before.stdout.trim() !== '') {
      anchor = before.stdout.trim()
      anchorSource = 'created'
    }
  }
  if (anchor === null) {
    return unknown(groomedAt !== '' ? `groomed-at ${groomedAt.slice(0, 7)} is not in this repository and created: gives no commit` : 'no groomed-at and no commit before created:')
  }

  const atAnchor = treeOf(projectRoot, anchor)
  const atBase = treeOf(projectRoot, baseSha)
  const kept = pathTokens(text).filter((p) => atAnchor.has(p) || atBase.has(p))
  if (kept.length === 0) return unknown('the plan names no path that exists at the anchor or the base', anchor, anchorSource)

  const count = (paths) => {
    const out = git(projectRoot, ['rev-list', '--count', `${anchor}..${baseSha}`, '--', ...paths])
    return out.status === 0 ? Number(out.stdout.trim()) || 0 : 0
  }
  const paths = kept.map((p) => ({ path: p, commits: count([p]), missing: atAnchor.has(p) && !atBase.has(p) }))
  const commits = count(kept)
  const drifted = commits > 0 || paths.some((p) => p.missing)
  return { status: drifted ? 'drifted' : 'none', anchor, anchorSource, commits, paths, reason: null }
}

/** The one-line rendering both CLIs print: `none`, `drifted — N commits since <sha> (<source>) touch: a, b; missing: c`, or `unknown — <why>`. */
export function driftLine(result) {
  if (result.status === 'none') return 'none'
  if (result.status === 'unknown') return `unknown — ${result.reason}`
  const touched = result.paths.filter((p) => p.commits > 0).map((p) => p.path)
  const missing = result.paths.filter((p) => p.missing).map((p) => p.path)
  const parts = []
  if (touched.length > 0) parts.push(`touch: ${touched.join(', ')}`)
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
  const noun = result.commits === 1 ? 'commit' : 'commits'
  return `drifted — ${result.commits} ${noun} since ${result.anchor.slice(0, 7)} (${result.anchorSource})${parts.length > 0 ? ` ${parts.join('; ')}` : ''}`
}
