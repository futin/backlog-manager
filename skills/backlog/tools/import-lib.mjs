// The pure half of `backlog.mjs import` (task-50, spec §8) — every text transformation the migration makes, and nothing else.
//
// What this module is. `import` moves a files project's whole `backlog/` store onto GitHub issues: one issue per item file, the `## Outcome` lifted out to be
// the closing comment, a footer carrying what the tracker has no field for, an over-cap body cut at a heading, and — in a second pass — every `bug-7`-shaped
// cross-reference rewritten to the `#<n>` it became. The requests live in `backlog.mjs`; the strings live here.
//
// Why it is pure, in a file of its own. Each function below is decided by exactly where a character sits — which line the Outcome heading is on, which byte the
// cap falls in, which neighbour a `-` has — and a table of inputs and expected outputs is the only honest way to prove one. Mixed into the command it would be
// provable only through a fake API and a git fixture, which is the shape that makes people write two cases instead of twenty-five. It imports NOTHING from
// `backlog.mjs` (one direction, no cycle) and nothing from node at all: no filesystem, no network, no clock.
//
// Why `rewriteOldIds` excludes `/` and `-` neighbours. The footer's readable line and the truncation link both carry an item's FILENAME
// (`backlog/tasks/open/task-1-foo.md`), so a rewrite that did not look at its neighbours would turn this module's own output into nonsense on the second pass —
// `backlog/tasks/open/#4-foo.md` — and would turn `sub-task-1` into `sub-#4` and `idea-12-tracker-backed` into `#7-tracker-backed`. Those are the cases the
// lookbehind and lookahead exist for, and they are pinned in `import-lib.test.mjs`.

/**
 * The body cap, with named headroom under GitHub's own 65,536 characters.
 *
 * The headroom is for PASS 2, which edits bodies after they are created and can only make them longer: a `_From #<n>._` line prepended to the top, and every
 * rewrite that grows (`ref-9` → `#123` is two characters more). A body created at exactly GitHub's limit would therefore be un-patchable, and pass 2's failure
 * mode is the expensive one — the issues already exist.
 */
export const IMPORT_BODY_CAP = 65000

const OUTCOME_HEADING = /^## Outcome\s*$/
const ANY_HEADING = /^## /

/**
 * Lift the `## Outcome` section out of an item body.
 *
 * Returns `{ rest, outcome }`: `rest` is the body without that section, `outcome` is the section's text with its heading removed and trimmed. The section runs
 * from its heading to the next `## ` line or the end of the text, which is the same "level two, exactly" rule `deriveGroomed` reads a `## Cause` with — a
 * `### Outcome` is somebody's sub-heading and is left where it is.
 *
 * Only `done/` items are split (the caller decides that): an open item has no outcome, and an `out-of-scope/` one is closed by `create` with no comment at all.
 */
export function splitOutcome(body) {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => OUTCOME_HEADING.test(line))
  if (start === -1) return { rest: body, outcome: '' }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i])) {
      end = i
      break
    }
  }

  const outcome = lines.slice(start + 1, end).join('\n').trim()
  const before = lines.slice(0, start)
  const after = lines.slice(end)
  // At most one blank line where the section was. The heading is usually preceded by a blank line AND followed by one, so a naive splice leaves two — visible
  // in the issue as a gap nobody wrote.
  while (before.length >= 2 && before[before.length - 1] === '' && before[before.length - 2] === '') before.pop()
  return { rest: [...before, ...after].join('\n'), outcome }
}

/**
 * The two-line footer every imported issue ends with.
 *
 * Line one is an HTML comment and is the IDEMPOTENCY KEY: a re-run lists the repo's issues, reads `from=<id>` out of it and skips those items (§8.6). Line two
 * is the same fact for a human scrolling the issue. They are two different things on purpose — the parser matches only the comment, so an issue whose body
 * merely mentions an old id is never mistaken for an imported one.
 *
 * `tags=` carries what the tracker has no field for: the label set is a closed eight (`server/src/tracker/labels.ts`), so free-text `tags:` become no label at
 * all, and the key is omitted entirely rather than written empty when an item has none.
 */
export function renderImportFooter({ id, created, tags, relPath }) {
  const parts = [`from=${id}`, `created=${created}`]
  if (Array.isArray(tags) && tags.length > 0) parts.push(`tags=${tags.join(',')}`)
  return `<!-- bm:imported ${parts.join(' ')} -->\n_Imported from backlog/${relPath}_`
}

const FOOTER_MARKER = /<!-- bm:imported from=([^\s]+)/

/** The old id out of a body's marker comment, or `null`. Never reads the readable line — see `renderImportFooter`. */
export function parseImportFooter(body) {
  const match = FOOTER_MARKER.exec(typeof body === 'string' ? body : '')
  return match === null ? null : match[1]
}

/** The SHA-pinned blob link §6.6 uses, which is what makes "HEAD is on an `origin/*` ref" a precondition of the whole command. */
export function blobLink(repo, sha, relPath) {
  return `https://github.com/${repo}/blob/${sha}/backlog/${relPath}`
}

/**
 * Cut a body to `cap`, at a `## ` boundary, and say whether it was cut.
 *
 * Whole sections from the top, never a character count: a body stopping mid-sentence reads as corruption, while a body that ends after its last whole section
 * and says so reads as what it is. The trailer links the full text at HEAD, so nothing is lost — the repository keeps the file in its own history.
 *
 * The preamble (everything before the first `## `) is segment zero and is kept or dropped like any other. A preamble that alone exceeds `cap` yields the
 * trailer ALONE, without its leading blank lines: there is nothing for them to separate it from.
 */
export function fitBody(text, cap, link) {
  if (text.length <= cap) return { text, truncated: false }

  const trailer = `\n\n_Truncated. Full text: ${link}_`
  const segments = []
  let current = ''
  for (const line of text.split('\n')) {
    if (ANY_HEADING.test(line) && current !== '') {
      segments.push(current)
      current = ''
    }
    current += current === '' ? line : `\n${line}`
  }
  segments.push(current)

  let kept = ''
  for (const segment of segments) {
    const candidate = kept === '' ? segment : `${kept}\n${segment}`
    if (candidate.length + trailer.length > cap) break
    kept = candidate
  }

  return { text: kept === '' ? trailer.trimStart() : kept + trailer, truncated: true }
}

// The four id shapes an item file can cite, word-bounded on both sides. `-` and `/` are excluded as left neighbours and `-` as a right one because a filename
// and a slug both carry an id in the middle of them; see this file's header comment for the three cases that proves.
const OLD_ID = /(?<![\w/-])(bug|task|idea|ref)-(\d+)(?![\w-])/g

/** Rewrite every old id the map knows to `#<n>`; leave every other match — an unknown id, a different casing — exactly as it was. */
export function rewriteOldIds(text, map) {
  return text.replace(OLD_ID, (match) => (map.has(match) ? `#${map.get(match)}` : match))
}

// Open first, because the open queue is what a reader scrolls; then done, then out-of-scope. Issue numbers are handed out in call order, so this ordering is
// the one thing `import` can do to make the numbers a human sees line up with the board.
const STATUS_RANK = { open: 0, done: 1, 'out-of-scope': 2 }
const SECTION_RANK = ['bugs', 'ideas', 'tasks', 'refactors']

const idNumber = (id) => {
  const match = /-(\d+)$/.exec(id)
  return match === null ? 0 : Number(match[1])
}

/**
 * Pass 1's order: status rank, then `created` ascending, then section, then numeric id.
 *
 * `created` is compared as a STRING because the frontmatter value is `YYYY-MM-DD`, which sorts correctly that way and needs no clock; a malformed one sorts
 * where its characters put it rather than throwing, since the import has already read the file and a date nobody can parse is not a reason to refuse the
 * migration. The last two keys exist only to make the order TOTAL: two items captured the same day would otherwise land in directory-read order, which differs
 * between machines and would make this function untestable.
 */
export function importOrder(items) {
  return [...items].sort((a, b) => {
    const status = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3)
    if (status !== 0) return status
    const created = String(a.created ?? '').localeCompare(String(b.created ?? ''))
    if (created !== 0) return created
    const section = (SECTION_RANK.indexOf(a.section) + 1 || 9) - (SECTION_RANK.indexOf(b.section) + 1 || 9)
    if (section !== 0) return section
    return idNumber(a.id) - idNumber(b.id)
  })
}

const COUNTER_KEYS = [
  ['groom-elapsed', 'groomElapsed'],
  ['execute-elapsed', 'executeElapsed'],
  ['groom-tokens', 'groomTokens'],
  ['execute-tokens', 'executeTokens'],
]

/**
 * The four permanent counters out of an item's frontmatter, or `null` when it has none.
 *
 * `null` is the load-bearing answer: counters ride a synthetic `claim`+`release` pair (decision §14.13), so an item without them must get no claim comment at
 * all — two extra writes and a stray assignee on every issue in the repo would be the alternative.
 *
 * A non-integer value THROWS rather than reading as zero. The caller wraps the message with the file's path: the counters are a permanent record of work
 * somebody did, and silently importing `abc` as `0` would erase it with nothing to say so.
 */
export function countersOf(data) {
  const counters = {}
  let any = false
  for (const [key, field] of COUNTER_KEYS) {
    const raw = data[key]
    if (raw === undefined || raw === '') {
      counters[field] = 0
      continue
    }
    if (!/^\d+$/.test(String(raw).trim())) throw new Error(`${key}: expected a non-negative integer, got ${JSON.stringify(String(raw))}`)
    const value = Number(String(raw).trim())
    counters[field] = value
    if (value !== 0) any = true
  }
  return any ? counters : null
}
