// Reviewer reports and verify statuses.
//
// `backlog-orchestrate` writes one `reviews/<id>-<pass>.md` per review pass
// and one `verify/<id>.status` holding the exit code of the item's proof
// commands. This module extracts what a retro cites and NOTHING it judges:
// the verdict, the pass number, and — for a `fix` verdict only — the
// Critical and Important sections verbatim. Deciding whether an Important
// finding was prose drift, a test that could not fail, or a real defect is
// the session's job (spec 3.2), and no regex here should ever try.
import fs from 'node:fs'
import path from 'node:path'

import { sidecarFiles, sidecarRoots } from './paths.mjs'

// `<id>-<pass>.md`. Anything else in the directory is not a review.
const REVIEW_NAME = /^([a-z]+-\d+)-(\d+)\.md$/

// The reviewer template puts `verdict: <word>` on its own line near the top.
// First match wins: a later occurrence is the reviewer quoting itself in
// prose, never a second verdict.
const VERDICT = /^verdict:\s*(\S+)\s*$/im

// A section body that means "nothing here". Written as a closed list rather
// than "short body" because the excerpts are what the session labels, and a
// one-line real finding must never be swallowed by a length heuristic.
// Optional markdown emphasis because reviewers write both `None.` and
// `*None.*`.
const EMPTY_SECTION = /^[*_]*\s*(none\.?|—|-|n\/a)\s*[*_]*$/i

// The text under a heading, up to the next heading of any level or the end
// of the file. Any heading level matches, because a reviewer that nested its
// findings under `### Critical` meant the same thing as `## Critical`.
function section(text, name) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${name}\\s*$`, 'i').test(l.trim()))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^#{1,6}\s+/.test(l.trim()))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  return EMPTY_SECTION.test(body) ? '' : body
}

// Every review under one project's run state, live and archived alike
// (task-31 moves a finished run's `reviews/` beside its run file).
export function readReviews(projectDirPath, project) {
  const reviews = []
  for (const { file, rel, name } of sidecarFiles(projectDirPath, 'reviews')) {
    const m = REVIEW_NAME.exec(name)
    if (!m) continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      console.error(`skipping unreadable review: ${file}`)
      continue
    }
    const verdictMatch = VERDICT.exec(text)
    const review = {
      // The citable key, in the shape labels.json uses (spec 3.2):
      // `<project>/reviews/<file>`. The absolute path rides beside it for
      // anyone who wants to open the thing.
      file: `${project}/${rel.split(path.sep).join('/')}`,
      abs: file,
      project,
      itemId: m[1],
      pass: Number(m[2]),
      verdict: verdictMatch ? verdictMatch[1].toLowerCase() : null,
    }
    // Excerpts on a `fix` verdict alone. An approving review has nothing to
    // label, and carrying its empty sections would put rows in front of the
    // session that have no judgement to make.
    if (review.verdict === 'fix') {
      review.critical = section(text, 'Critical')
      review.important = section(text, 'Important')
    }
    reviews.push(review)
  }
  return reviews
}

// The exit code the run recorded for an item's proof commands, or `null`
// when it never got that far. Searched across the archive directories too,
// but the project directory's own `verify/` is first in `sidecarRoots` and
// wins on a tie: it belongs to the live run, which is the most recent thing
// to have proved anything about this item.
export function readVerifyStatus(projectDirPath, itemId) {
  for (const root of sidecarRoots(projectDirPath)) {
    let text
    try {
      text = fs.readFileSync(path.join(root, 'verify', `${itemId}.status`), 'utf8')
    } catch {
      continue
    }
    const code = Number(text.trim())
    if (Number.isFinite(code)) return code
  }
  return null
}
