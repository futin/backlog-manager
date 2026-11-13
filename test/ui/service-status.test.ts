import { githubDown, jiraDown, newestAge, serviceTone, type ServiceRow } from '../../client/src/lib/service-status';
import type { SyncInterval } from '../../shared/types';

const NOW = Date.parse('2026-09-18T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const row = (ms: number | null, interval: SyncInterval | null = '15s'): ServiceRow => ({ polledAt: ms === null ? null : ago(ms), interval });
const input = (rows: ServiceRow[], over: { down?: boolean; limited?: boolean } = {}) => ({ down: false, limited: false, rows, ...over });

describe('serviceTone', () => {
  it('is green while every syncing row is inside twice its interval', () => {
    expect(serviceTone(input([row(5_000), row(30_000)]), NOW)).toBe('green');
  });

  it('turns amber one second past twice the interval, and not before', () => {
    expect(serviceTone(input([row(30_000)]), NOW)).toBe('green');
    expect(serviceTone(input([row(31_000)]), NOW)).toBe('amber');
  });

  it('judges each row by its own interval, never the 15 s tick', () => {
    expect(serviceTone(input([row(4 * 60_000, '5m')]), NOW)).toBe('green');
    expect(serviceTone(input([row(31_000, '15s')]), NOW)).toBe('amber');
    // One late row among on-time ones is enough.
    expect(serviceTone(input([row(4 * 60_000, '5m'), row(31_000, '15s')]), NOW)).toBe('amber');
  });

  it('reads a null interval as the default 15 s', () => {
    expect(serviceTone(input([row(31_000, null)]), NOW)).toBe('amber');
  });

  it('ignores off rows entirely, however old', () => {
    expect(serviceTone(input([row(5_000), row(86_400_000, 'off')]), NOW)).toBe('green');
    // And an off row's poll does not count as "something was polled": grey, not green.
    expect(serviceTone(input([row(5_000, 'off')]), NOW)).toBe('grey');
  });

  it('is red when down, ahead of everything else', () => {
    expect(serviceTone(input([row(5_000)], { down: true }), NOW)).toBe('red');
    expect(serviceTone(input([], { down: true }), NOW)).toBe('red');
  });

  it('is grey when nothing has ever been polled', () => {
    expect(serviceTone(input([row(null), row(null)]), NOW)).toBe('grey');
    expect(serviceTone(input([]), NOW)).toBe('grey');
  });

  it('is amber while rate-limited, even with fresh polls', () => {
    expect(serviceTone(input([row(5_000)], { limited: true }), NOW)).toBe('amber');
  });

  it('does not call a never-polled row late while another row has polled', () => {
    expect(serviceTone(input([row(5_000), row(null)]), NOW)).toBe('green');
  });
});

describe('newestAge', () => {
  it('is the age of the newest poll in pollAge’s vocabulary, null before any', () => {
    expect(newestAge([row(40_000), row(12_000)], NOW)).toBe('12 s');
    expect(newestAge([row(null)], NOW)).toBeNull();
    expect(newestAge([], NOW)).toBeNull();
  });
});

describe('down', () => {
  it('GitHub: no token, or every row refused; ok, rate-limited and unread are alive', () => {
    expect(githubDown(false, ['ok'])).toBe(true);
    expect(githubDown(true, ['forbidden', 'not-found'])).toBe(true);
    expect(githubDown(true, ['ok', 'forbidden'])).toBe(false);
    expect(githubDown(true, ['rate-limited'])).toBe(false);
    expect(githubDown(true, [null])).toBe(false);
  });

  it('Jira: anything but ok or rate-limited', () => {
    expect(jiraDown('ok')).toBe(false);
    expect(jiraDown('rate-limited')).toBe(false);
    expect(jiraDown('unauthorized')).toBe(true);
    expect(jiraDown('unreachable')).toBe(true);
  });
});
