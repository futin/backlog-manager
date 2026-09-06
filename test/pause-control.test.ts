import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearPauseRequest, controlFile, controlHome, pauseRequestEffective, readPauseRequest, writePauseRequest
} from '../server/src/orchestrator/pause-control.util';

/**
 * pause-control.util.ts is the SECOND file this server writes (the watchdog
 * config was the first), and the only one a skill's own tool reads back —
 * `orchestrate.mjs` opens exactly this path at its two dispatch gates. That
 * makes two things worth pinning directly here rather than through the route
 * that calls them: the PATH, byte for byte, because the tool computes it
 * from its own duplicated copy of these two functions and a divergence would
 * be silent (a pause that simply never arrives), and the PREDICATE, because
 * both processes derive it independently and a disagreement means one of
 * them thinks a run is pausing while the other works on.
 *
 * Every case passes `env`/`root` explicitly, so nothing here mutates
 * `process.env` or touches the real control directory even by accident.
 */

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bm-pause-control-'));
}

/** The minimum a run needs to be judged against — the same `Pick` the
 *  predicate itself takes, so a test can never hand it more context than
 *  the real caller has. */
function fakeRun(over: Partial<{ runId: string; startedAt: string; unpausedAt?: string }> = {}) {
  return { runId: 'run-20260905-100000', startedAt: '2026-09-05T10:00:00.000Z', ...over };
}

describe('controlHome', () => {
  it('defaults under the settings/ directory the compose mount makes writable', () => {
    expect(controlHome({})).toBe(join(homedir(), '.backlog-manager', 'settings', 'orchestrator-control'));
  });

  it('honours BM_ORCH_CONTROL_HOME, the escape hatch every test and the tool share', () => {
    expect(controlHome({ BM_ORCH_CONTROL_HOME: '/x' })).toBe('/x');
  });
});

describe('controlFile', () => {
  // The exact string `orchestrate.mjs`'s `controlFilePath` produces. A flat
  // file per project, encodeURIComponent-keyed like every other project key
  // in this system — pinned as a literal because the tool's copy is pinned
  // as a literal too, and two literals that disagree fail loudly where two
  // implementations that disagree would not.
  it('is one encodeURIComponent-keyed file per project, flat under the root', () => {
    expect(controlFile('/a/b', '/r')).toBe(join('/r', '%2Fa%2Fb.json'));
  });
});

describe('readPauseRequest', () => {
  it('answers null when no request has ever been written', () => {
    expect(readPauseRequest('/a/b', tempRoot())).toBeNull();
  });

  // Total by construction: this file is written by one process and read by
  // another, and a malformed one must never throw into a request handler or
  // wedge a run at its dispatch gate.
  it.each([
    ['unparseable JSON', 'not json'],
    ['no requestedAt', JSON.stringify({ runId: 'r' })],
    ['no runId', JSON.stringify({ requestedAt: '2026-09-05T11:00:00.000Z' })],
    ['a non-string runId', JSON.stringify({ runId: 1, requestedAt: '2026-09-05T11:00:00.000Z' })],
    ['an array', JSON.stringify([{ runId: 'r', requestedAt: '2026-09-05T11:00:00.000Z' }])]
  ])('answers null, without throwing, for %s', (_label, body) => {
    const root = tempRoot();
    writeFileSync(controlFile('/a/b', root), body);
    expect(readPauseRequest('/a/b', root)).toBeNull();
  });

  it('returns the request when the file is well-formed', () => {
    const root = tempRoot();
    const request = { runId: 'run-1', requestedAt: '2026-09-05T11:00:00.000Z' };
    writeFileSync(controlFile('/a/b', root), JSON.stringify(request));
    expect(readPauseRequest('/a/b', root)).toEqual(request);
  });
});

describe('pauseRequestEffective', () => {
  it('is false for no request at all', () => {
    expect(pauseRequestEffective(null, fakeRun())).toBe(false);
  });

  // The runId clause: a request that outlived the run it was made for must
  // never pause the NEXT run of the same project.
  it('is false for a request pinned to another run', () => {
    expect(pauseRequestEffective({ runId: 'run-other', requestedAt: '2026-09-05T11:00:00.000Z' }, fakeRun())).toBe(false);
  });

  it('is false for a request made before the run started', () => {
    expect(pauseRequestEffective({ runId: 'run-20260905-100000', requestedAt: '2026-09-05T09:00:00.000Z' }, fakeRun())).toBe(false);
  });

  it('is true for a request made after the run started, when it has never been resumed', () => {
    expect(pauseRequestEffective({ runId: 'run-20260905-100000', requestedAt: '2026-09-05T11:00:00.000Z' }, fakeRun())).toBe(true);
  });

  // `unpausedAt` outranks `startedAt` once it exists — this is what retires
  // the very request that paused the run, so a resumed run does not stop
  // itself again at its first dispatch gate.
  it('is false for a request the resume has already moved past', () => {
    const run = fakeRun({ unpausedAt: '2026-09-05T12:00:00.000Z' });
    expect(pauseRequestEffective({ runId: run.runId, requestedAt: '2026-09-05T11:00:00.000Z' }, run)).toBe(false);
  });

  it('is true for a request made after the resume', () => {
    const run = fakeRun({ unpausedAt: '2026-09-05T12:00:00.000Z' });
    expect(pauseRequestEffective({ runId: run.runId, requestedAt: '2026-09-05T13:00:00.000Z' }, run)).toBe(true);
  });

  it.each([
    ['an unparseable requestedAt', { runId: 'run-20260905-100000', requestedAt: 'yesterday' }, fakeRun()],
    ['an unparseable startedAt', { runId: 'run-20260905-100000', requestedAt: '2026-09-05T11:00:00.000Z' }, fakeRun({ startedAt: 'nonsense' })]
  ])('is false for %s', (_label, request, run) => {
    expect(pauseRequestEffective(request, run)).toBe(false);
  });
});

describe('writePauseRequest / clearPauseRequest', () => {
  it('creates the directory and the file, and returns what it wrote', () => {
    const root = join(tempRoot(), 'nested');
    const now = new Date('2026-09-05T11:00:00.000Z');

    const result = writePauseRequest('/a/b', 'run-1', now, root);

    expect(result).toEqual({ runId: 'run-1', requestedAt: '2026-09-05T11:00:00.000Z' });
    expect(JSON.parse(readFileSync(controlFile('/a/b', root), 'utf8'))).toEqual(result);
  });

  // The atomic write's own guarantee, which is only a guarantee if the
  // rename actually happened: a leftover `.tmp` sibling means the temp file
  // was written and never swapped in, and the tool would read the old one.
  it('leaves no temp file behind', () => {
    const root = tempRoot();
    writePauseRequest('/a/b', 'run-1', new Date(), root);
    expect(readdirSync(root).filter((name) => name.includes('tmp'))).toEqual([]);
  });

  it('replaces an existing request rather than appending a second one', () => {
    const root = tempRoot();
    writePauseRequest('/a/b', 'run-1', new Date('2026-09-05T11:00:00.000Z'), root);
    writePauseRequest('/a/b', 'run-1', new Date('2026-09-05T11:05:00.000Z'), root);

    expect(readdirSync(root)).toHaveLength(1);
    expect(readPauseRequest('/a/b', root)?.requestedAt).toBe('2026-09-05T11:05:00.000Z');
  });

  it('removes the file, and is a no-op when there is nothing to remove', () => {
    const root = tempRoot();
    writePauseRequest('/a/b', 'run-1', new Date(), root);

    clearPauseRequest('/a/b', root);
    expect(existsSync(controlFile('/a/b', root))).toBe(false);
    expect(() => clearPauseRequest('/a/b', root)).not.toThrow();
  });
});
