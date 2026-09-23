import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QUEUED_LABEL, TRACKER_LABELS, TRACKER_LABEL_NAMES, TYPE_LABELS } from '../server/src/tracker/labels';

/**
 * The label set has one home — `server/src/tracker/labels.ts` — and one place
 * that cannot import it: `skills/backlog/tools/backlog.mjs`, whose `connect`
 * command writes four issue forms that each pre-apply a `type:*` label.
 *
 * A skill's `tools/` is installed as a standalone copy of what was pushed,
 * with no build step and no path back into `server/`, and CLAUDE.md forbids
 * one skill's tools reaching into another's for exactly that reason. So the
 * agreement between the two lists is enforced the other way round: this suite
 * reads the SKILL'S SOURCE as text and asserts the labels its forms apply are
 * exactly the four this build's mapping reads. A comment asking two files to
 * stay in step is what drifts; a red test is what does not.
 *
 * The same technique the cross-skill prose guards in
 * `skills/backlog/tools/backlog.test.mjs` already use — read the other file,
 * never import it.
 */
const CONNECT_SOURCE = readFileSync(join(__dirname, '..', 'skills', 'backlog', 'tools', 'backlog.mjs'), 'utf8');

/** Every `label: 'type:…'` the issue-form table assigns. Matched on the text
 *  rather than by importing the table, because importing it is precisely what
 *  the boundary rules out. */
function formLabels(): string[] {
  return [...CONNECT_SOURCE.matchAll(/label:\s*'(type:[a-z]+)'/g)].map((m) => m[1]).sort();
}

describe('the nine labels', () => {
  it('names exactly the set spec §5.2 lists, plus orchestrator:queued last', () => {
    expect(TRACKER_LABEL_NAMES).toEqual([
      'type:bug',
      'type:idea',
      'type:task',
      'type:refactor',
      'kind:chore',
      'kind:debt',
      'runner-fix',
      'in-progress',
      'orchestrator:queued'
    ]);
    expect(TRACKER_LABELS).toHaveLength(9);
  });

  /* The ninth label arrived with the orchestrator:queued spec (§1), appended
     rather than inserted so the bootstrap's diff against an existing repo is
     exactly one create. Its name has one spelling, exported, so the write
     route and the Stop sweep import it instead of repeating the string. */
  it('ends with orchestrator:queued, exported as QUEUED_LABEL with the description the spec fixes', () => {
    expect(QUEUED_LABEL).toBe('orchestrator:queued');
    expect(TRACKER_LABELS[TRACKER_LABELS.length - 1]).toEqual({
      name: QUEUED_LABEL,
      color: expect.stringMatching(/^[0-9a-f]{6}$/),
      description: "In a live orchestrator run's queue, not yet picked up — a plan, not a claim"
    });
  });

  it('gives every label a colour and a description GitHub will accept', () => {
    for (const label of TRACKER_LABELS) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      expect(label.description.length).toBeGreaterThan(0);
      // GitHub truncates a label description past 100 characters, which would
      // make the created label differ from the one this file describes.
      expect(label.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('agrees with the type labels the connect command’s issue forms apply', () => {
    expect(formLabels()).toEqual([...TYPE_LABELS].sort());
  });

  it('keeps out-of-scope off the type list, because it is a closed state and not a type', () => {
    expect(TYPE_LABELS).not.toContain('type:out-of-scope');
    // The state a rejected issue reaches is `closed` with a reason other than
    // `completed`; its type label stays on it so the original type is
    // recoverable (spec §5.3).
    expect(TRACKER_LABEL_NAMES.filter((n) => n.startsWith('type:'))).toEqual([...TYPE_LABELS]);
  });
});
