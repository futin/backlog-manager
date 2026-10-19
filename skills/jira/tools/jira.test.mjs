// jira.mjs's suite: the pure helpers by import, and the CLI end to end as a child process against a fake API that runs in this process.
//
// The fake stands in for the backlog-manager server, never for Jira: jira.mjs's one network peer is `/api/jira` on 127.0.0.1 (spec §10), so what the suite
// can pin is what that peer is sent and how its answers become stdout, stderr and an exit code.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { normaliseKey, exitForStatus, formatStatus, resolveTransition, formatTransitions, USAGE, API_DOWN_CODE } from './jira.mjs'

const SCRIPT = fileURLToPath(new URL('./jira.mjs', import.meta.url))

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The harness. A copy of backlog.test.mjs's `fakeApi` / `runNode` / `withApi` shape, not an import: a skill's tests sit beside its tool and reach no other
// skill's files for their machinery.

/** The fake API: records every request and answers from a per-path table. A string body is sent as `text/plain`, anything else as JSON. */
function fakeApi(routes) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = new URL(req.url, 'http://127.0.0.1')
      let body = null
      try {
        body = raw === '' ? null : JSON.parse(raw)
      } catch {
        body = raw
      }
      const query = Object.fromEntries(url.searchParams)
      requests.push({ method: req.method, path: url.pathname, query, headers: req.headers, body })

      const answer = routes[url.pathname]
      const resolved = typeof answer === 'function' ? answer(body, { method: req.method, query }) : answer
      if (resolved === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `no fake route for ${url.pathname}` }))
        return
      }
      const status = resolved.status ?? 200
      const payload = resolved.body
      const type = typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json'
      res.writeHead(status, { 'content-type': type })
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null))
    })
  })
  return { server, requests }
}

/**
 * The CLI as a child, spawned ASYNCHRONOUSLY. The fake API runs in this process, and `spawnSync` would block the event loop that has to accept the child's
 * connection — the child would wait on an accept that cannot happen until it has exited, and the case would read like a stack that is down.
 */
function runCli(port, ...args) {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...args], { env: { ...process.env, BM_API_PORT: String(port) } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

/** Stand the fake up on 127.0.0.1 (never the wildcard — test/helpers/app.ts says why), run `fn` against its port, tear it down. */
async function withApi(routes, fn) {
  const { server, requests } = fakeApi(routes)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return { out: await fn(port), requests }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const cli = (routes, ...args) => withApi(routes, (port) => runCli(port, ...args))

const STATUS_OK = {
  configured: true,
  configUnreadable: null,
  site: 'acme.atlassian.net',
  me: { accountId: 'abc', name: 'Ada Lovelace' },
  access: 'ok',
  detail: null,
  boards: [{ id: '1' }, { id: '2' }],
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Pure helpers.

test('normaliseKey trims and upper-cases a key, and refuses anything that is not one', () => {
  assert.equal(normaliseKey('PAY-131'), 'PAY-131')
  assert.equal(normaliseKey(' pay-131 '), 'PAY-131')
  assert.equal(normaliseKey('AB_2-7'), 'AB_2-7')
  for (const raw of ['PAY', '131', '1PAY-1', 'PAY-1x', 'PAY-131/../../agents/status', 'PAY-1?format=text', '']) {
    assert.equal(normaliseKey(raw), null, `${JSON.stringify(raw)} was taken for a key`)
  }
})

test('exitForStatus: a 4xx is 2, a 5xx and anything else is 3', () => {
  for (const s of [400, 404, 409]) assert.equal(exitForStatus(s), 2, String(s))
  for (const s of [500, 502, 503, 302]) assert.equal(exitForStatus(s), 3, String(s))
})

test('formatStatus: configured and ok is four lines and exit 0', () => {
  assert.deepEqual(formatStatus(STATUS_OK), {
    stdout: 'site: acme.atlassian.net\nsigned in as: Ada Lovelace\naccess: ok\nboards: 2',
    stderr: '',
    code: 0,
  })
})

test('formatStatus: no identity, an access detail, and an unreadable jira.json', () => {
  assert.match(formatStatus({ ...STATUS_OK, me: null }).stdout, /^signed in as: no identity$/m)
  const bad = formatStatus({ ...STATUS_OK, access: 'unauthorized', detail: 'Jira rejected the credentials' })
  assert.match(bad.stdout, /^access: unauthorized — Jira rejected the credentials$/m)
  assert.equal(bad.code, 3)
  const unreadable = formatStatus({ ...STATUS_OK, configUnreadable: 'does not parse as JSON' })
  assert.equal(unreadable.stdout.split('\n')[4], 'jira.json: cannot be read — does not parse as JSON')
  assert.equal(unreadable.code, 0, 'an unreadable jira.json does not change the exit by itself')
})

test('formatStatus: not configured is stderr only and exit 3, with the dash only when there is a detail', () => {
  assert.deepEqual(formatStatus({ ...STATUS_OK, configured: false, detail: 'BM_JIRA_TOKEN is not set' }), {
    stdout: '',
    stderr: 'Jira is not configured on this machine — BM_JIRA_TOKEN is not set',
    code: 3,
  })
  assert.equal(formatStatus({ ...STATUS_OK, configured: false, detail: null }).stderr, 'Jira is not configured on this machine')
})

test('USAGE has one line per command, and API_DOWN_CODE is 5', () => {
  for (const cmd of ['show', 'transitions', 'transition', 'assign', 'status']) {
    assert.match(USAGE, new RegExp(`^\\s*jira\\.mjs ${cmd}\\b`, 'm'), `USAGE has no line for ${cmd}`)
  }
  assert.equal(API_DOWN_CODE, 5)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// show.

test('show normalises the key, asks for the text block, and prints it verbatim with one newline', async () => {
  const routes = { '/api/jira/issue/PAY-131': (_b, { query }) => (query.format === 'text' ? { body: 'PAY-131 Fix the thing\n\nbody' } : undefined) }
  const { out, requests } = await cli(routes, 'show', 'pay-131')
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout, 'PAY-131 Fix the thing\n\nbody\n')
  assert.equal(requests.length, 1)
  const [r] = requests
  assert.equal(r.method, 'GET')
  assert.equal(r.path, '/api/jira/issue/PAY-131')
  assert.deepEqual(r.query, { format: 'text' })
  assert.equal(r.headers.connection, 'close')
  for (const h of ['origin', 'authorization', 'content-type']) assert.equal(r.headers[h], undefined, `show sent ${h}`)
})

test('show adds no second newline to a text that already ends in one', async () => {
  const { out } = await cli({ '/api/jira/issue/PAY-131': { body: 'block\n' } }, 'show', 'PAY-131')
  assert.equal(out.stdout, 'block\n')
})

test('show refuses a key that is not one, with exit 1 and no request (RF 3)', async () => {
  const { out, requests } = await cli({}, 'show', 'PAY-131/../../agents/status')
  assert.equal(out.status, 1)
  assert.match(out.stderr, /not a Jira issue key: PAY-131\/\.\.\/\.\.\/agents\/status — expected a key like PAY-131/)
  assert.equal(requests.length, 0)
})

test("show maps the server's refusals onto 2 and 3, printing its sentence verbatim (RF 2)", async () => {
  const cases = [
    [{ status: 404, body: { error: 'issue not found' } }, 2, 'issue not found'],
    [{ status: 503, body: { error: 'Jira is not configured' } }, 3, 'Jira is not configured'],
    [
      { status: 503, body: { error: 'Jira rate limit — retry after 2026-10-19T12:00:00.000Z', retryAt: '2026-10-19T12:00:00.000Z' } },
      3,
      'Jira rate limit — retry after 2026-10-19T12:00:00.000Z',
    ],
    [{ status: 502, body: '<html>bad gateway</html>' }, 3, 'the API answered 502'],
  ]
  for (const [answer, code, sentence] of cases) {
    const { out } = await cli({ '/api/jira/issue/PAY-9': answer }, 'show', 'PAY-9')
    assert.equal(out.status, code, `${answer.status}: ${out.stderr}`)
    assert.equal(out.stderr.trim(), sentence)
    assert.equal(out.stdout, '')
  }
})

test('a 2xx whose JSON body cannot be read is exit 3, not a success', async () => {
  const { out } = await cli({ '/api/jira': { body: '<html>ok</html>' } }, 'status')
  assert.equal(out.status, 3)
  assert.equal(out.stderr.trim(), 'the API answered 200 with a body jira.mjs cannot read')
})

test('nothing listening is exit 5 with the stack-down sentence naming the port', async () => {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  const out = await runCli(port, 'show', 'PAY-1')
  assert.equal(out.status, 5)
  assert.equal(
    out.stderr.trim(),
    `the backlog-manager API is not running on 127.0.0.1:${port} — start it with \`pnpm run dev\` or \`pnpm run docker:up\` in the backlog-manager checkout; every jira.mjs command needs it`,
  )
})

test('show passes a 200 000-byte ticket through a pipe whole (RF 5)', async () => {
  const text = 'x'.repeat(199_999) + 'y'
  const { out } = await cli({ '/api/jira/issue/PAY-1': { body: text } }, 'show', 'PAY-1')
  assert.equal(out.status, 0)
  assert.equal(Buffer.byteLength(out.stdout), 200_001)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// status.

test('status reads GET /api/jira and exits 0 only when access is ok', async () => {
  const ok = await cli({ '/api/jira': { body: STATUS_OK } }, 'status')
  assert.equal(ok.out.status, 0)
  assert.equal(ok.out.stdout, 'site: acme.atlassian.net\nsigned in as: Ada Lovelace\naccess: ok\nboards: 2\n')
  assert.deepEqual(
    ok.requests.map((r) => [r.method, r.path]),
    [['GET', '/api/jira']],
  )

  const unauthorized = await cli({ '/api/jira': { body: { ...STATUS_OK, access: 'unauthorized', detail: 'Jira rejected the credentials' } } }, 'status')
  assert.equal(unauthorized.out.status, 3)
  assert.match(unauthorized.out.stdout, /^access: unauthorized — Jira rejected the credentials$/m)

  const unconfigured = await cli({ '/api/jira': { body: { ...STATUS_OK, configured: false, detail: 'BM_JIRA_TOKEN is not set' } } }, 'status')
  assert.equal(unconfigured.out.status, 3)
  assert.equal(unconfigured.out.stdout, '')
  assert.equal(unconfigured.out.stderr.trim(), 'Jira is not configured on this machine — BM_JIRA_TOKEN is not set')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// transitions, transition, assign.

const START = { id: '11', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' } }
const DONE = { id: '21', name: 'Done', to: { name: 'Done', category: 'done' } }
const REVIEW = { id: '31', name: 'Review', to: { name: 'In Progress', category: 'indeterminate' } }
const ALL = [START, DONE, REVIEW]

const idOf = (r) => (r.ok ? r.transition.id : r)

test('resolveTransition matches id, then transition name, then target status, stopping at the first step that matches', () => {
  assert.equal(idOf(resolveTransition(ALL, '21', 'PAY-1')), '21')
  assert.equal(idOf(resolveTransition(ALL, 'start', 'PAY-1')), '11')
  assert.equal(idOf(resolveTransition(ALL, '  Done ', 'PAY-1')), '21')
  assert.deepEqual(resolveTransition(ALL, 'In Progress', 'PAY-1'), {
    ok: false,
    code: 2,
    message: '"In Progress" is ambiguous for PAY-1 — Start (→ In Progress), Review (→ In Progress)',
  })
  assert.equal(idOf(resolveTransition([START, DONE], 'in progress', 'PAY-1')), '11')
  const namedEleven = { id: '40', name: '11', to: { name: 'Blocked', category: 'indeterminate' } }
  assert.equal(idOf(resolveTransition([namedEleven, START], '11', 'PAY-1')), '11', 'an exact id must win over a transition named the same')
  assert.deepEqual(resolveTransition(ALL, 'Close', 'PAY-1'), {
    ok: false,
    code: 2,
    message: '"Close" is not offered for PAY-1 — offered: Start (→ In Progress), Done (→ Done), Review (→ In Progress)',
  })
  assert.deepEqual(resolveTransition([], 'Done', 'PAY-1'), { ok: false, code: 2, message: 'PAY-1 offers no transitions' })
})

test('formatTransitions prints id, label and category, tab-separated, one per line', () => {
  assert.equal(formatTransitions('PAY-1', ALL), '11\tStart → In Progress\tindeterminate\n21\tDone\tdone\n31\tReview → In Progress\tindeterminate')
  assert.equal(formatTransitions('PAY-1', []), 'PAY-1 offers no transitions')
})

const detail = (transitions) => ({ '/api/jira/issue/PAY-1': (_b, { method }) => (method === 'GET' ? { body: { key: 'PAY-1', transitions } } : undefined) })

test('transitions reads the JSON detail route and lists what it offers', async () => {
  const { out, requests } = await cli(detail(ALL), 'transitions', 'pay-1')
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout, '11\tStart → In Progress\tindeterminate\n21\tDone\tdone\n31\tReview → In Progress\tindeterminate\n')
  assert.deepEqual(
    requests.map((r) => [r.method, r.path, r.query]),
    [['GET', '/api/jira/issue/PAY-1', {}]],
  )

  const none = await cli(detail([]), 'transitions', 'PAY-1')
  assert.equal(none.out.status, 0, 'asking what is offered is not a refusal')
  assert.equal(none.out.stdout, 'PAY-1 offers no transitions\n')
})

const writable = (transitions, post = { body: { ok: true, reread: true } }) => ({
  ...detail(transitions),
  '/api/jira/issue/transition': (_b, { method }) => (method === 'POST' ? post : undefined),
})

test('transition reads, resolves, then posts the id as JSON, with words joined without quotes', async () => {
  const { out, requests } = await cli(writable([START, DONE]), 'transition', 'PAY-1', 'In', 'Progress')
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout, 'PAY-1: Start → In Progress\n')
  assert.deepEqual(
    requests.map((r) => [r.method, r.path]),
    [
      ['GET', '/api/jira/issue/PAY-1'],
      ['POST', '/api/jira/issue/transition'],
    ],
  )
  const post = requests[1]
  assert.equal(post.headers['content-type'], 'application/json')
  assert.equal(post.headers.origin, undefined)
  assert.deepEqual(post.body, { key: 'PAY-1', transitionId: '11' })
})

test('transition posts nothing when the argument is ambiguous, not offered, or missing (RF 4)', async () => {
  const ambiguous = await cli(writable(ALL), 'transition', 'PAY-1', 'In', 'Progress')
  assert.equal(ambiguous.out.status, 2)
  assert.equal(ambiguous.out.stderr.trim(), '"In Progress" is ambiguous for PAY-1 — Start (→ In Progress), Review (→ In Progress)')
  assert.equal(ambiguous.requests.filter((r) => r.method === 'POST').length, 0)

  const close = await cli(writable(ALL), 'transition', 'PAY-1', 'Close')
  assert.equal(close.out.status, 2)
  assert.equal(close.requests.filter((r) => r.method === 'POST').length, 0)

  const bare = await cli(writable(ALL), 'transition', 'PAY-1')
  assert.equal(bare.out.status, 1)
  assert.equal(bare.requests.length, 0)
})

test("transition reports the server's re-check when the workflow moved between the two reads (RF 4)", async () => {
  const { out } = await cli(writable(ALL, { status: 400, body: { error: 'transition not offered' } }), 'transition', 'PAY-1', 'Done')
  assert.equal(out.status, 2)
  assert.equal(out.stderr.trim(), 'transition not offered')
})

test('transition posts nothing when the read fails, and a 5xx read is exit 3 (RF 2)', async () => {
  const routes = {
    '/api/jira/issue/PAY-1': { status: 503, body: { error: 'Jira rejected the credentials', access: 'unauthorized' } },
    '/api/jira/issue/transition': { body: { ok: true, reread: true } },
  }
  const { out, requests } = await cli(routes, 'transition', 'PAY-1', 'Done')
  assert.equal(out.status, 3)
  assert.equal(out.stderr.trim(), 'Jira rejected the credentials')
  assert.equal(requests.filter((r) => r.method === 'POST').length, 0)
})

const assignRoute = (answer) => ({ '/api/jira/issue/assign': (_b, { method }) => (method === 'POST' ? answer : undefined) })

test('assign posts the key as JSON and says so, whether or not the server could re-read', async () => {
  for (const reread of [true, false]) {
    const { out, requests } = await cli(assignRoute({ body: { ok: true, reread } }), 'assign', 'pay-1')
    assert.equal(out.status, 0, out.stderr)
    assert.equal(out.stdout, 'PAY-1 assigned to you\n')
    assert.equal(requests.length, 1)
    const [r] = requests
    assert.deepEqual([r.method, r.path], ['POST', '/api/jira/issue/assign'])
    assert.equal(r.headers['content-type'], 'application/json')
    assert.equal(r.headers.origin, undefined)
    assert.deepEqual(r.body, { key: 'PAY-1' })
  }
})

test("assign maps the server's refusals: no identity is 3, Jira's refusal and the guard's are 2", async () => {
  const cases = [
    [{ status: 503, body: { error: 'no identity' } }, 3, 'no identity'],
    [{ status: 409, body: { error: 'Jira refused: User cannot be assigned' } }, 2, 'Jira refused: User cannot be assigned'],
    [{ status: 403, body: { error: 'this endpoint accepts application/json only' } }, 2, 'this endpoint accepts application/json only'],
  ]
  for (const [answer, code, sentence] of cases) {
    const { out } = await cli(assignRoute(answer), 'assign', 'PAY-1')
    assert.equal(out.status, code, String(answer.status))
    assert.equal(out.stderr.trim(), sentence)
  }
})

test('assign with two keys is usage and sends nothing', async () => {
  const { out, requests } = await cli(assignRoute({ body: { ok: true, reread: true } }), 'assign', 'PAY-1', 'PAY-2')
  assert.equal(out.status, 1)
  assert.equal(requests.length, 0)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Usage (R8).

test('usage: no command is exit 1 with USAGE on stderr; help in any spelling is exit 0 with USAGE on stdout', async () => {
  const none = await cli({})
  assert.equal(none.out.status, 1)
  assert.ok(none.out.stderr.startsWith('unknown command: (none)\n'), none.out.stderr)
  assert.ok(none.out.stderr.includes(USAGE))
  for (const help of ['--help', '-h', 'help']) {
    const { out } = await cli({}, help)
    assert.equal(out.status, 0, help)
    assert.ok(out.stdout.includes(USAGE), help)
  }
})

test('usage: a wrong argument count, a flag, or an unknown command is exit 1 and sends nothing', async () => {
  for (const args of [['show'], ['show', 'PAY-1', 'PAY-2'], ['show', '--json', 'PAY-1'], ['bogus']]) {
    const { out, requests } = await cli({}, ...args)
    assert.equal(out.status, 1, args.join(' '))
    assert.equal(requests.length, 0, args.join(' '))
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The source guard (spec §10's half a test can hold). Comment lines are stripped first: the header may well name Atlassian while saying it is never called.

const codeLines = () =>
  fs
    .readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))

test('jira.mjs talks to 127.0.0.1 only, carries no Jira credential, and never calls process.exit', () => {
  const code = codeLines().join('\n')
  assert.ok(!code.includes('process.exit('), 'process.exit( truncates a pipe')
  assert.ok(!/atlassian/i.test(code), 'jira.mjs names an Atlassian host')
  assert.ok(!code.includes('BM_JIRA_'), 'jira.mjs reads a Jira credential variable')
  assert.ok(!/authorization/i.test(code), 'jira.mjs builds an authorization header')
  // A scheme followed by a host; a bare `'http://'` (the stack-down sentence strips it from the base) names no host and is not counted.
  const hosts = [...code.matchAll(/https?:\/\/[^\s`'"$/]+/g)].map((m) => m[0])
  assert.deepEqual([...new Set(hosts)], ['http://127.0.0.1:'])
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// SKILL.md and the plugin description. The prose is the reviewer's to judge; these are the needles a later trim must not lose, each failing by name.

const SKILL_MD = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const PLUGIN_JSON = fileURLToPath(new URL('../../../.claude-plugin/plugin.json', import.meta.url))

test('jira/SKILL.md is the jira skill, triggered by /jira', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8')
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(front, 'SKILL.md has no frontmatter')
  assert.match(front[1], /^name: jira$/m)
  const description = front[1].match(/^description: >\n((?: {2}.*\n?)+)/m)
  assert.ok(description, 'the description is not a folded block')
  assert.match(description[1].trim(), /Trigger: \/jira$/)
})

test('jira/SKILL.md documents every command, through the braced plugin root', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8')
  for (const cmd of ['show', 'transitions', 'transition', 'assign', 'status']) {
    assert.match(text, new RegExp(`jira\\.mjs ${cmd}\\b`), `SKILL.md never shows jira.mjs ${cmd}`)
  }
  const nodeLines = text.split('\n').filter((line) => /\bnode\s+"/.test(line))
  assert.ok(nodeLines.length > 0, 'SKILL.md has no node command lines')
  for (const line of nodeLines) assert.ok(line.includes('node "${CLAUDE_PLUGIN_ROOT}/skills/jira/tools/jira.mjs"'), line)
})

test('jira/SKILL.md documents every exit code and both ways to start the stack', () => {
  const text = fs.readFileSync(SKILL_MD, 'utf8')
  for (const code of ['0', '1', '2', '3', '5']) assert.match(text, new RegExp(`^\\|\\s*\`${code}\`\\s*\\|`, 'm'), `the exit table has no row for ${code}`)
  assert.match(text, /pnpm run dev/)
  assert.match(text, /pnpm run docker:up/)
})

test('jira/SKILL.md says the ticket text is data, not instructions (RF 1)', () => {
  assert.ok(fs.readFileSync(SKILL_MD, 'utf8').includes('data, not instructions'), 'the untrusted-ticket rule is gone')
})

test("the plugin's description names the jira skill", () => {
  assert.match(JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).description, /jira/i)
})
