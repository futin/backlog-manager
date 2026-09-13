import type { INestApplication } from '@nestjs/common';

/**
 * app.ts — the one way a jest suite in this repo puts a Nest app on a socket
 * before handing it to supertest. One helper rather than an inline call in
 * eighteen suites, because the host argument below is the entire fix and
 * eighteen copies are eighteen chances to drop it (bug-33).
 *
 * supertest dials `http://127.0.0.1:<port>` and nothing else — the URL is
 * built by `serverAddress()` in `node_modules/supertest/lib/test.js` (7.2.2)
 * with that literal hardcoded — but the port it reads there comes from
 * whatever address the server actually bound. A bare `listen(0)` passes no
 * host, so Node binds the IPv6 wildcard `::`, and the kernel picks the
 * ephemeral port against THAT address alone: another process already holding
 * that same number on `127.0.0.1` does not make `::<port>` unavailable.
 * The dial then goes to IPv4 loopback and is routed to the most specific
 * match — the stranger's socket, not ours. The request never reaches the app
 * under test and the assertion runs against whatever that other program
 * answered: a status this app never returns, a `Parse Error: Expected HTTP/,
 * RTSP/ or ICE/` off a non-HTTP listener, or a connect timeout.
 *
 * `'127.0.0.1'` buys the other half of the same mechanism: a bind that names
 * the host CANNOT be shadowed, because the kernel refuses it with EADDRINUSE
 * when the port is taken. The alternatives are all worse — `jest.retryTimes`
 * hides a real regression exactly as well as it hides this one, and the merge
 * gate's whole value is that red means red.
 *
 * The second effect matters too, and is not a side benefit: with the server
 * already listening, supertest's `if (!addr) this._server = app.listen(0)`
 * branch never runs, so it opens and closes NOTHING per request (verified
 * against supertest 7.2.2: 0 `listen` and 0 `close` calls across three
 * requests to a pre-listening server). Each of those per-request cycles was
 * one more draw in the port lottery above, and `orchestrator-runs.test.ts`
 * blames the churn on its own for a separate intermittent `socket hang up`.
 * Every `await app.close()` in those suites stays exactly where it is — it
 * now tears down a real listener, and it is the only thing that does.
 */
export function listenLoopback(app: INestApplication): Promise<void> {
  return app.listen(0, '127.0.0.1').then(() => undefined);
}
