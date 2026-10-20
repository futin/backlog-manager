// jira.mjs's suite: the pure helpers by import, and the CLI end to end as a child process against a fake API that runs in this process.
//
// The fake stands in for the backlog-manager server, never for Jira: jira.mjs's one network peer is `/api/jira` on 127.0.0.1 (spec §10), so what the suite
// can pin is what that peer is sent and how its answers become stdout, stderr and an exit code.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  normaliseKey,
  exitForStatus,
  formatStatus,
  resolveTransition,
  formatTransitions,
  USAGE,
  API_DOWN_CODE,
  branchNameProblem,
  branchCarriesKey,
  isLockFailure,
  ensureExcludeLines,
} from './jira.mjs'

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
  const connecting = formatStatus({ ...STATUS_OK, me: null, detail: 'connecting' })
  assert.match(connecting.stdout, /^signed in as: no identity$/m)
  // `access: ok` with no identity is a boot still connecting: every issue call meets the server's `connecting` 502 until `me` lands, so `status && …` must
  // not read true yet.
  assert.equal(connecting.code, 3, 'access ok with no identity is not "the next call can work"')
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
  for (const cmd of ['show', 'transitions', 'transition', 'assign', 'status', 'worktree']) {
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
    `the backlog-manager API is not running on 127.0.0.1:${port} — start it with \`pnpm run dev\` or \`pnpm run docker:up\` in the backlog-manager checkout; every jira.mjs command but worktree needs it`,
  )
})

test('a body cut off mid-read is exit 3 with the unreadable sentence, not a stack trace', async () => {
  // Not the fake: it cannot promise more bytes than it sends. A raw server that announces 1000 and dies after 3 is the connection reset the fetch body meets.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
    res.write('{"a')
    setImmediate(() => res.socket.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const out = await runCli(server.address().port, 'status')
    assert.equal(out.status, 3, out.stderr)
    assert.equal(out.stderr.trim(), 'the API answered 200 with a body jira.mjs cannot read')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a transition missing its target status is exit 3, not a stack trace', async () => {
  const { out } = await cli(writable([{ id: '11', name: 'Start' }]), 'transitions', 'PAY-1')
  assert.equal(out.status, 3, out.stderr)
  assert.doesNotMatch(out.stderr, /\n\s+at /, 'a stack trace reached stderr')
})

test('show passes a 200 000-byte ticket through a pipe whole (RF 5)', async () => {
  const text = 'x'.repeat(199_999) + 'y'
  const { out } = await cli({ '/api/jira/issue/PAY-1': { body: text } }, 'show', 'PAY-1')
  assert.equal(out.status, 0)
  assert.equal(Buffer.byteLength(out.stdout), 200_001)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// status.

test('status reads GET /api/jira and exits 0 only when access is ok and someone is signed in', async () => {
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

  // An empty shell variable: an argument that is there and says nothing is the same usage error as one that is missing.
  const empty = await cli(writable(ALL), 'transition', 'PAY-1', '', ' ')
  assert.equal(empty.out.status, 1, empty.out.stderr)
  assert.equal(empty.requests.length, 0)
})

test("transition reports the server's re-check when the workflow moved between the two reads, naming the key and what is offered now (RF 4)", async () => {
  // The workflow moves between the first read and the POST: the GET after the refusal sees only `Start`.
  let reads = 0
  const moved = {
    '/api/jira/issue/PAY-1': (_b, { method }) => (method === 'GET' ? { body: { key: 'PAY-1', transitions: reads++ === 0 ? ALL : [START] } } : undefined),
    '/api/jira/issue/transition': (_b, { method }) => (method === 'POST' ? { status: 400, body: { error: 'transition not offered' } } : undefined),
  }
  const { out, requests } = await cli(moved, 'transition', 'PAY-1', 'Done')
  assert.equal(out.status, 2)
  assert.equal(out.stderr.trim(), 'PAY-1: transition not offered — offered: Start (→ In Progress)')
  assert.deepEqual(
    requests.map((r) => [r.method, r.path]),
    [
      ['GET', '/api/jira/issue/PAY-1'],
      ['POST', '/api/jira/issue/transition'],
      ['GET', '/api/jira/issue/PAY-1'],
    ],
  )

  // A re-read that fails costs only the list: the key and the server's sentence still print, and the exit is still the POST's `2`.
  reads = 0
  const blind = {
    ...moved,
    '/api/jira/issue/PAY-1': (_b, { method }) =>
      method !== 'GET' ? undefined : reads++ === 0 ? { body: { key: 'PAY-1', transitions: ALL } } : { status: 503, body: { error: 'Jira unreachable' } },
  }
  const second = await cli(blind, 'transition', 'PAY-1', 'Done')
  assert.equal(second.out.status, 2)
  assert.equal(second.out.stderr.trim(), 'PAY-1: transition not offered')
})

test("a stack older than the Jira routes — Nest's own 404, with `statusCode` — says to rebuild or restart it, not `Not Found`", async () => {
  const nest404 = (method, route) => ({ status: 404, body: { message: `Cannot ${method} ${route}`, error: 'Not Found', statusCode: 404 } })
  const cases = [
    [{ '/api/jira/issue/assign': nest404('POST', '/api/jira/issue/assign') }, ['assign', 'PAY-1'], 'POST /api/jira/issue/assign'],
    [{ '/api/jira/issue/PAY-1': nest404('GET', '/api/jira/issue/PAY-1') }, ['show', 'PAY-1'], 'GET /api/jira/issue/PAY-1'],
    [{ '/api/jira': nest404('GET', '/api/jira') }, ['status'], 'GET /api/jira'],
  ]
  for (const [routes, args, route] of cases) {
    const { out } = await cli(routes, ...args)
    assert.equal(out.status, 2, out.stderr)
    assert.equal(
      out.stderr.trim(),
      `the API has no ${route} — rebuild or restart the backlog-manager stack (\`pnpm run docker:sync\`, or restart \`pnpm run dev\`) ` +
        'in the backlog-manager checkout',
    )
  }
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
// worktree — the one git command (spec §5.4). Tables A and B are re-implemented in jira.mjs rather than imported from shared/jira-branch.ts (no skill's
// `tools/` imports `shared/`), so the same rows are pinned here against the tool's own copies: a rule changed on one side and not the other goes red here.

test('Table A: branchNameProblem — first hit wins, the exact sentences', () => {
  for (const ok of ['feature/timify-123-x', 'TIMIFY-123', 'release/1.2', 'a_b.c']) assert.equal(branchNameProblem(ok), null, ok)
  const rows = [
    ['', 'is empty'],
    ['a'.repeat(201), 'is longer than 200 characters'],
    ['feat ure', 'may hold only A-Z a-z 0-9 . _ / -'],
    ['feat~1', 'may hold only A-Z a-z 0-9 . _ / -'],
    ['a:b', 'may hold only A-Z a-z 0-9 . _ / -'],
    ['a@b', 'may hold only A-Z a-z 0-9 . _ / -'],
    ['ä', 'may hold only A-Z a-z 0-9 . _ / -'],
    ['-x', 'may not start with -'],
    ['a..b', 'may not contain ..'],
    ['/a', 'may not start or end with /, or contain //'],
    ['a/', 'may not start or end with /, or contain //'],
    ['a//b', 'may not start or end with /, or contain //'],
    ['a/.b', 'may not have a part starting with .'],
    ['.a', 'may not have a part starting with .'],
    ['a.lock', 'may not have a part ending in .lock'],
    ['a.lock/b', 'may not have a part ending in .lock'],
    ['a.', 'may not end with .'],
  ]
  for (const [name, problem] of rows) assert.equal(branchNameProblem(name), problem, JSON.stringify(name))
  assert.equal(branchNameProblem('a'.repeat(200)), null, 'exactly 200 is allowed')
})

test('Table B: branchCarriesKey — case-insensitive, bounded on both sides by a non-alphanumeric or the end', () => {
  for (const yes of ['TIMIFY-123-fix-login', 'feature/timify-123-x', 'hotfix/timify-123', 'TIMIFY-123', 'feature/timify-123_x']) {
    assert.equal(branchCarriesKey(yes, 'TIMIFY-123'), true, yes)
  }
  for (const no of ['timify-1234-x', 'xtimify-123', '1timify-123', 'feature/timify-12-x', 'develop']) {
    assert.equal(branchCarriesKey(no, 'TIMIFY-123'), false, no)
  }
  // Every occurrence is tried: an unbounded hit earlier must not hide a bounded one later.
  assert.equal(branchCarriesKey('xtimify-123/timify-123', 'TIMIFY-123'), true)
})

test('isLockFailure is true only for a lock git could not take', () => {
  assert.equal(isLockFailure("error: cannot lock ref 'refs/remotes/origin/main': is at 1 but expected 2"), true)
  assert.equal(isLockFailure("cannot lock ref 'refs/remotes/origin/main'"), true)
  assert.equal(isLockFailure("Unable to create '/r/.git/shallow.lock': File exists."), true)
  assert.equal(isLockFailure("fatal: 'origin' does not appear to be a git repository"), false)
  assert.equal(isLockFailure(''), false)
})

test('ensureExcludeLines appends only the whole lines missing, newline-safe, and says what it appended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-exclude-'))
  const file = path.join(dir, 'info', 'exclude')
  assert.deepEqual(ensureExcludeLines(dir, ['.worktrees/', 'node_modules']), ['.worktrees/', 'node_modules'])
  assert.equal(fs.readFileSync(file, 'utf8'), '.worktrees/\nnode_modules\n')
  assert.deepEqual(ensureExcludeLines(dir, ['.worktrees/', 'node_modules']), [])
  // A substring is not a line, and a last line without its newline gets one before the append.
  fs.writeFileSync(file, '# mine\nnode_modules_old')
  assert.deepEqual(ensureExcludeLines(dir, ['node_modules']), ['node_modules'])
  assert.equal(fs.readFileSync(file, 'utf8'), '# mine\nnode_modules_old\nnode_modules\n')
})

// The fixtures are real git: a bare `origin` with `main` and `develop`, a `seed` clone that plays everybody else pushing, and a `repo` clone that is the
// mapped repository, with a `node_modules/` of its own. Every git here and every CLI child sees no global or system config, so the machine's hooks, commit
// signing and default branch cannot decide what a fixture commit does. Tmp roots come from `os.tmpdir()`, which `test:skills` points at its own run root.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }

function gitTry(cwd, ...args) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' })
}

function git(cwd, ...args) {
  const r = gitTry(cwd, ...args)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function configUser(dir) {
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fixture@example.invalid')
}

let fixtureCommit = 0

function commitFile(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), text)
  git(dir, 'add', '--', file)
  git(dir, 'commit', '-q', '-m', `${file}: ${text.trim()}`)
  return git(dir, 'rev-parse', 'HEAD')
}

function wtFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-wt-'))
  const origin = path.join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  const seed = path.join(root, 'seed')
  git(root, 'clone', '-q', origin, seed)
  configUser(seed)
  git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  commitFile(seed, 'README.md', 'seed\n')
  git(seed, 'push', '-q', 'origin', 'main', 'main:develop')
  const repo = path.join(root, 'repo')
  git(root, 'clone', '-q', origin, repo)
  configUser(repo)
  fs.mkdirSync(path.join(repo, 'node_modules'))
  fs.writeFileSync(path.join(repo, 'node_modules', 'marker'), '')
  return { root, origin, seed, repo }
}

/** Somebody else pushes `n` commits to `origin/<branch>`, starting from `origin/<from>` (the branch itself by default). Returns the new tip. */
function pushCommits(fx, branch, n, from = branch) {
  git(fx.seed, 'fetch', '-q', 'origin')
  git(fx.seed, 'checkout', '-q', '-B', branch, `origin/${from}`)
  let tip = ''
  for (let i = 0; i < n; i++) tip = commitFile(fx.seed, `pushed-${++fixtureCommit}.txt`, `${branch} ${i}\n`)
  git(fx.seed, 'push', '-q', 'origin', `${branch}:${branch}`)
  return tip
}

/** The mapped repo learns about `origin/<branch>` and makes a local branch of it, with no checkout. */
function localFromOrigin(fx, branch) {
  git(fx.repo, 'fetch', '-q', 'origin')
  git(fx.repo, 'branch', '-q', '--no-track', branch, `origin/${branch}`)
}

function runWorktree(args, env = {}) {
  const r = spawnSync('node', [SCRIPT, 'worktree', ...args], { env: { ...GIT_ENV, ...env }, encoding: 'utf8' })
  let json = null
  try {
    json = r.status === 0 ? JSON.parse(r.stdout) : null
  } catch {
    // Left null; the case's own assertion names what came back.
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

const wtArgs = (fx, mode, branch, base, key = 'TIMIFY-123') => [
  key,
  '--repo',
  fx.repo,
  '--mode',
  mode,
  '--branch',
  branch,
  ...(base === undefined ? [] : ['--base', base]),
]

const worktreeList = (fx) => git(fx.repo, 'worktree', 'list', '--porcelain')
const excludeCount = (fx, line) =>
  fs
    .readFileSync(path.join(fx.repo, '.git', 'info', 'exclude'), 'utf8')
    .split('\n')
    .filter((l) => l === line).length

test('worktree usage: missing or malformed arguments are exit 1 with the usage line, before git is asked anything', () => {
  const fx = wtFixture()
  const before = worktreeList(fx)
  const usageLine = /usage: jira\.mjs worktree <KEY> --repo <path> --mode new\|continue --branch <name> \[--base <name>\]/
  const cases = [
    [[], usageLine],
    [wtArgs(fx, 'new', 'TIMIFY-123-x'), /--base is required with --mode new/],
    [wtArgs(fx, 'continue', 'TIMIFY-123-x', 'main'), /--base is not taken with --mode continue/],
    [wtArgs(fx, 'sideways', 'TIMIFY-123-x', 'main'), /--mode must be new or continue/],
    [['TIMIFY-123', '--mode', 'new', '--branch', 'TIMIFY-123-x', '--base', 'main'], /--repo is required/],
    [['TIMIFY-123', '--repo', fx.repo, '--branch', 'TIMIFY-123-x', '--base', 'main'], /--mode is required/],
    [['TIMIFY-123', '--repo', fx.repo, '--mode', 'new', '--base', 'main'], /--branch is required/],
    [wtArgs(fx, 'new', 'TIMIFY-123-x', 'main', 'not a key'), /not a Jira issue key: not a key/],
    [wtArgs(fx, 'new', 'a..b', 'main'), /--branch may not contain \.\./],
    [wtArgs(fx, 'new', 'TIMIFY-123-x', 'ma in'), /--base may hold only A-Z a-z 0-9 \. _ \/ -/],
    [[...wtArgs(fx, 'new', 'TIMIFY-123-x', 'main'), '--force'], /unknown option --force/],
    [[...wtArgs(fx, 'new', 'TIMIFY-123-x', 'main'), '--branch', 'TIMIFY-123-y'], /--branch given twice/],
    [['TIMIFY-123', '--repo'], /--repo needs a value/],
  ]
  for (const [args, said] of cases) {
    const out = runWorktree(args)
    assert.equal(out.status, 1, `${args.join(' ')}: ${out.stderr}`)
    assert.match(out.stderr, said, args.join(' '))
    assert.match(out.stderr, usageLine, args.join(' '))
    assert.equal(out.stdout, '', args.join(' '))
  }
  assert.equal(worktreeList(fx), before)
  assert.equal(fs.existsSync(path.join(fx.repo, '.worktrees')), false)
})

test('worktree makes no HTTP request, and a path that is not a git top level is exit 4', async () => {
  const fx = wtFixture()
  const plain = path.join(fx.root, 'plain')
  fs.mkdirSync(plain)
  const { out, requests } = await cli({}, 'worktree', 'TIMIFY-123', '--repo', plain, '--mode', 'new', '--branch', 'TIMIFY-123-x', '--base', 'main')
  assert.equal(out.status, 4, out.stderr)
  assert.equal(out.stderr.trim(), `${plain} is not a git repository`)
  assert.equal(requests.length, 0)
  // Inside a repository but not its top level is not the mapped checkout either; nor is a path that does not exist.
  for (const repo of [path.join(fx.repo, 'node_modules'), path.join(fx.root, 'missing')]) {
    const sub = runWorktree(['TIMIFY-123', '--repo', repo, '--mode', 'new', '--branch', 'TIMIFY-123-x', '--base', 'main'])
    assert.equal(sub.status, 4, repo)
    assert.match(sub.stderr, /is not a git repository/)
  }
})

test('worktree new cuts the branch from origin/<base> after the fetch, with no upstream, and wires exclude and node_modules', () => {
  const fx = wtFixture()
  git(fx.repo, 'branch', '-q', 'develop', 'origin/develop')
  const ahead = pushCommits(fx, 'develop', 1)
  const out = runWorktree(wtArgs(fx, 'new', 'feature/TIMIFY-123-x', 'develop'))
  assert.equal(out.status, 0, out.stderr)
  const tree = path.join(fx.repo, '.worktrees', 'feature-TIMIFY-123-x')
  assert.deepEqual(out.json, { worktree: tree, branch: 'feature/TIMIFY-123-x', created: 'new', notes: [] })
  assert.equal(git(tree, 'rev-parse', 'HEAD'), ahead, 'cut from the fetched origin/develop, not the stale local develop')
  assert.equal(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/TIMIFY-123-x')
  assert.notEqual(gitTry(tree, 'rev-parse', '--abbrev-ref', 'feature/TIMIFY-123-x@{upstream}').status, 0, 'a new branch has no upstream')
  assert.equal(excludeCount(fx, '.worktrees/'), 1)
  assert.equal(excludeCount(fx, 'node_modules'), 1)
  const link = path.join(tree, 'node_modules')
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(fx.repo, 'node_modules')))
  assert.equal(git(fx.repo, 'status', '--porcelain'), '', 'the mapped checkout stays clean')
})

test('worktree new twice, two branches: each exclude line is still there once', () => {
  const fx = wtFixture()
  for (const branch of ['TIMIFY-123-a', 'TIMIFY-123-b']) {
    const out = runWorktree(wtArgs(fx, 'new', branch, 'main'))
    assert.equal(out.status, 0, out.stderr)
    assert.equal(out.json.created, 'new')
  }
  assert.equal(excludeCount(fx, '.worktrees/'), 1)
  assert.equal(excludeCount(fx, 'node_modules'), 1)
})

test('worktree new refuses a name that exists, a name without the key, and a base that does not exist — creating nothing', () => {
  const fx = wtFixture()
  pushCommits(fx, 'TIMIFY-123-taken', 1, 'main')
  git(fx.repo, 'branch', '-q', 'TIMIFY-123-local', 'main')
  const before = worktreeList(fx)
  const refusals = [
    [wtArgs(fx, 'new', 'TIMIFY-123-taken', 'main'), 'TIMIFY-123-taken exists — Start again with Continue'],
    [wtArgs(fx, 'new', 'TIMIFY-123-local', 'main'), 'TIMIFY-123-local exists — Start again with Continue'],
    [wtArgs(fx, 'new', 'fix-login', 'main'), 'branch must carry TIMIFY-123'],
    [wtArgs(fx, 'new', 'TIMIFY-123-x', 'nope'), 'no base nope locally or on origin'],
  ]
  for (const [args, said] of refusals) {
    const out = runWorktree(args)
    assert.equal(out.status, 4, out.stderr)
    assert.equal(out.stderr.trim(), said)
  }
  assert.equal(worktreeList(fx), before)
  assert.equal(fs.existsSync(path.join(fx.repo, '.worktrees')), false)
  assert.notEqual(gitTry(fx.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/TIMIFY-123-taken').status, 0, 'no local branch was made')
})

test('worktree continue on a branch only origin has makes a local branch tracking it', () => {
  const fx = wtFixture()
  const tip = pushCommits(fx, 'TIMIFY-123-remote', 1, 'main')
  const out = runWorktree(wtArgs(fx, 'continue', 'TIMIFY-123-remote'))
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.json.created, 'tracked')
  assert.equal(out.json.worktree, path.join(fx.repo, '.worktrees', 'TIMIFY-123-remote'))
  assert.equal(git(out.json.worktree, 'rev-parse', 'HEAD'), tip)
  assert.equal(git(out.json.worktree, 'rev-parse', '--abbrev-ref', 'TIMIFY-123-remote@{upstream}'), 'origin/TIMIFY-123-remote')
})

test('worktree continue on a local branch 2 behind origin attaches it and fast-forwards', () => {
  const fx = wtFixture()
  pushCommits(fx, 'TIMIFY-123-behind', 1, 'main')
  localFromOrigin(fx, 'TIMIFY-123-behind')
  const tip = pushCommits(fx, 'TIMIFY-123-behind', 2)
  const out = runWorktree(wtArgs(fx, 'continue', 'TIMIFY-123-behind'))
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.json.created, 'attached')
  assert.deepEqual(out.json.notes, ['fast-forwarded 2 commits'])
  assert.equal(git(out.json.worktree, 'rev-parse', 'HEAD'), tip)
  assert.ok(fs.lstatSync(path.join(out.json.worktree, 'node_modules')).isSymbolicLink())
})

test('worktree continue on a branch that exists nowhere is exit 4', () => {
  const fx = wtFixture()
  const out = runWorktree(wtArgs(fx, 'continue', 'TIMIFY-123-none'))
  assert.equal(out.status, 4)
  assert.equal(out.stderr.trim(), 'no branch TIMIFY-123-none locally or on origin')
})

test('worktree continue on a diverged branch is exit 4 before any tree is made — also when a tree of its own holds it', () => {
  const fx = wtFixture()
  pushCommits(fx, 'TIMIFY-123-d', 1, 'main')
  localFromOrigin(fx, 'TIMIFY-123-d')
  // One local commit with no checkout at all, then one on origin: 1 ahead, 1 behind.
  const tree = git(fx.repo, 'rev-parse', 'TIMIFY-123-d^{tree}')
  const local = git(fx.repo, 'commit-tree', tree, '-p', 'TIMIFY-123-d', '-m', 'local')
  git(fx.repo, 'update-ref', 'refs/heads/TIMIFY-123-d', local)
  pushCommits(fx, 'TIMIFY-123-d', 1)
  const before = worktreeList(fx)
  const out = runWorktree(wtArgs(fx, 'continue', 'TIMIFY-123-d'))
  assert.equal(out.status, 4)
  assert.equal(out.stderr.trim(), 'TIMIFY-123-d has diverged from origin/TIMIFY-123-d (1 ahead, 1 behind) — never reset, never merged')
  assert.equal(worktreeList(fx), before)
  assert.equal(fs.existsSync(path.join(fx.repo, '.worktrees')), false)
  assert.equal(git(fx.repo, 'rev-parse', 'TIMIFY-123-d'), local, 'the branch is where it was')

  // The variant: a hand-made sibling tree holds the diverged branch. Still refused, and that tree is not moved.
  const fy = wtFixture()
  pushCommits(fy, 'TIMIFY-123-d', 1, 'main')
  localFromOrigin(fy, 'TIMIFY-123-d')
  const sibling = path.join(fy.root, 'hand-made')
  git(fy.repo, 'worktree', 'add', '-q', sibling, 'TIMIFY-123-d')
  const mine = commitFile(sibling, 'mine.txt', 'mine\n')
  pushCommits(fy, 'TIMIFY-123-d', 1)
  const held = runWorktree(wtArgs(fy, 'continue', 'TIMIFY-123-d'))
  assert.equal(held.status, 4)
  assert.match(held.stderr, /has diverged/)
  assert.equal(git(sibling, 'rev-parse', 'HEAD'), mine)
})

test('worktree continue on a branch a tree holds detached mid-rebase is exit 4 naming that tree', () => {
  const fx = wtFixture()
  git(fx.repo, 'branch', '-q', 'TIMIFY-123-r', 'main')
  const sibling = path.join(fx.root, 'rebasing')
  git(fx.repo, 'worktree', 'add', '-q', sibling, 'TIMIFY-123-r')
  commitFile(sibling, 'README.md', 'theirs\n')
  commitFile(fx.repo, 'README.md', 'ours\n')
  assert.notEqual(gitTry(sibling, 'rebase', 'main').status, 0, 'the fixture rebase must stop on its conflict')
  assert.match(worktreeList(fx), /\ndetached$/m, 'git lists the rebasing tree as detached')
  const before = worktreeList(fx)
  const out = runWorktree(wtArgs(fx, 'continue', 'TIMIFY-123-r'))
  assert.equal(out.status, 4, out.stderr)
  assert.match(out.stderr, /^TIMIFY-123-r is held by the worktree at .+ \(detached, likely mid-rebase\) — finish or abort there first$/m)
  assert.ok(out.stderr.includes(sibling) || out.stderr.includes(fs.realpathSync(sibling)), out.stderr)
  assert.equal(worktreeList(fx), before)
  assert.equal(fs.existsSync(path.join(fx.repo, '.worktrees')), false, 'the refused add left no directory behind')
})

test('worktree continue on the branch the mapped checkout holds is exit 4 naming the checkout', () => {
  const fx = wtFixture()
  const out = runWorktree(wtArgs(fx, 'continue', 'main'))
  assert.equal(out.status, 4)
  assert.equal(out.stderr.trim(), `main is checked out in the mapped checkout ${fx.repo} — a worktree cannot take it`)
})

test('worktree continue enters a tree that already holds the branch: dirty is left behind, clean is fast-forwarded', () => {
  const fx = wtFixture()
  pushCommits(fx, 'TIMIFY-123-e', 1, 'main')
  localFromOrigin(fx, 'TIMIFY-123-e')
  const sibling = path.join(fx.root, 'by-hand')
  git(fx.repo, 'worktree', 'add', '-q', sibling, 'TIMIFY-123-e')
  const head = git(sibling, 'rev-parse', 'HEAD')
  const tip = pushCommits(fx, 'TIMIFY-123-e', 1)
  fs.writeFileSync(path.join(sibling, 'README.md'), 'dirty\n')

  const dirty = runWorktree(wtArgs(fx, 'continue', 'TIMIFY-123-e'))
  assert.equal(dirty.status, 0, dirty.stderr)
  assert.equal(dirty.json.created, 'entered')
  assert.equal(fs.realpathSync(dirty.json.worktree), fs.realpathSync(sibling))
  assert.deepEqual(dirty.json.notes, ['behind origin by 1, not fast-forwarded: uncommitted changes'])
  assert.equal(git(sibling, 'rev-parse', 'HEAD'), head)
  assert.equal(fs.existsSync(path.join(sibling, 'node_modules')), false, 'a tree it did not create gets no link')

  git(sibling, 'checkout', '-q', '--', 'README.md')
  const clean = runWorktree(wtArgs(fx, 'continue', 'TIMIFY-123-e'))
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(clean.json.created, 'entered')
  assert.deepEqual(clean.json.notes, ['fast-forwarded 1 commit'])
  assert.equal(git(sibling, 'rev-parse', 'HEAD'), tip)
})

test('worktree refuses a target path another branch or a plain directory already holds (Review Focus 1)', () => {
  const fx = wtFixture()
  const first = runWorktree(wtArgs(fx, 'new', 'feature/a-TIMIFY-1', 'main', 'TIMIFY-1'))
  assert.equal(first.status, 0, first.stderr)
  const target = path.join(fx.repo, '.worktrees', 'feature-a-TIMIFY-1')
  const out = runWorktree(wtArgs(fx, 'new', 'feature-a/TIMIFY-1', 'main', 'TIMIFY-1'))
  assert.equal(out.status, 4)
  assert.equal(out.stderr.trim(), `${target} already exists (holds feature/a-TIMIFY-1)`)
  assert.notEqual(gitTry(fx.repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature-a/TIMIFY-1').status, 0)

  fs.mkdirSync(path.join(fx.repo, '.worktrees', 'TIMIFY-123-p'))
  const plain = runWorktree(wtArgs(fx, 'new', 'TIMIFY-123-p', 'main'))
  assert.equal(plain.status, 4)
  assert.equal(plain.stderr.trim(), `${path.join(fx.repo, '.worktrees', 'TIMIFY-123-p')} already exists (is not a worktree)`)
})

test('worktree with no origin at all goes on from local refs and says so (Review Focus 2)', () => {
  const fx = wtFixture()
  git(fx.repo, 'remote', 'remove', 'origin')
  const out = runWorktree(wtArgs(fx, 'new', 'TIMIFY-123-off', 'main'))
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.json.created, 'new')
  assert.ok(out.json.notes.some((n) => n.startsWith('fetch failed: ') && n.endsWith(' — using refs as of last fetch')), out.json.notes.join(' | '))
  assert.ok(out.json.notes.includes('cut from local main: no origin/main'), out.json.notes.join(' | '))
})

test('worktree: a fetch that cannot take its ref lock is retried, then reported, and the run goes on', () => {
  const fx = wtFixture()
  const stale = git(fx.repo, 'rev-parse', 'origin/main')
  // An up-to-date fetch locks nothing and would pass, so origin/main moves first.
  pushCommits(fx, 'main', 1)
  const lock = path.join(fx.repo, '.git', 'refs', 'remotes', 'origin', 'main.lock')
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.writeFileSync(lock, '')
  const out = runWorktree(wtArgs(fx, 'new', 'TIMIFY-123-lock', 'main'), { BM_JIRA_FETCH_RETRY_MS: '10' })
  assert.equal(out.status, 0, out.stderr)
  assert.ok(out.json.notes.some((n) => n.startsWith('fetch failed: ') && n.includes('cannot lock ref')), out.json.notes.join(' | '))
  assert.equal(git(out.json.worktree, 'rev-parse', 'HEAD'), stale, 'cut from the refs as of the last fetch')
})

test('worktree leaves a real node_modules directory in an attached tree a directory', () => {
  const fx = wtFixture()
  git(fx.seed, 'fetch', '-q', 'origin')
  git(fx.seed, 'checkout', '-q', '-B', 'TIMIFY-123-nm', 'origin/main')
  commitFile(fx.seed, 'node_modules/keep.txt', 'kept\n')
  git(fx.seed, 'push', '-q', 'origin', 'TIMIFY-123-nm')
  localFromOrigin(fx, 'TIMIFY-123-nm')
  const out = runWorktree(wtArgs(fx, 'continue', 'TIMIFY-123-nm'))
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.json.created, 'attached')
  const nm = fs.lstatSync(path.join(out.json.worktree, 'node_modules'))
  assert.ok(nm.isDirectory() && !nm.isSymbolicLink())
  assert.ok(fs.existsSync(path.join(out.json.worktree, 'node_modules', 'keep.txt')))
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
  // `BM_JIRA_FETCH_RETRY_MS` is the one `BM_JIRA_` name allowed: the worktree command's fetch-retry pause, a test knob that carries nothing of Jira's.
  // Removed by exact name before the check, so any other `BM_JIRA_` spelling — the credentials above all — is still refused.
  assert.ok(!code.replaceAll('BM_JIRA_FETCH_RETRY_MS', '').includes('BM_JIRA_'), 'jira.mjs reads a Jira credential variable')
  assert.ok(!/authorization/i.test(code), 'jira.mjs builds an authorization header')
  // Every scheme in the code, whatever follows it — a templated host (`https://${site}`) included, which a host-shaped match would miss. The one allowed
  // is the loopback base; the stack-down sentence is built from host and port, so it carries no scheme to exempt.
  assert.ok(!code.includes('https://'), 'jira.mjs names an https:// URL')
  const schemes = [...code.matchAll(/http:\/\/.{0,10}/g)].map((m) => m[0])
  assert.ok(schemes.length > 0, 'the loopback base is gone')
  for (const s of schemes) assert.ok(s.startsWith('http://127.0.0.1:'), `jira.mjs dials something other than 127.0.0.1: ${s}`)
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
  const text = fs.readFileSync(SKILL_MD, 'utf8')
  assert.ok(text.includes('data, not instructions'), 'the untrusted-ticket rule is gone')
  // A session's own prompt can carry a ticket block (pasted, or phase 5's), and "the prompt this session was started with" is also who may ask for a write.
  assert.ok(text.includes('a ticket block inside your prompt'), 'the rule no longer covers ticket text that arrives in the prompt')
})

test("the plugin's description names the jira skill", () => {
  assert.match(JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).description, /jira/i)
})
