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
import { normaliseKey, exitForStatus, formatStatus, USAGE, API_DOWN_CODE } from './jira.mjs'

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
