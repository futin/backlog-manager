/**
 * @jest-environment jsdom
 */
import { useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { PrActions } from '../client/src/components/github/PrActions';
import { PrFoot } from '../client/src/components/github/PrFoot';
import { PrOutcomeLine } from '../client/src/components/github/PrOutcomeLine';
import type { PrOutcome } from '../client/src/lib/prs';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../shared/types';

/**
 * The one key strip and the foot under a PR row (`.claude/DESIGN.md` §8.11; spec `2026-10-30-prs-page-fixes-design.md`, "One key strip, one foot").
 * `PrActions` and `PrFoot` are drawn through a small harness that holds the confirming key in state as the page does: `Merge` sets it, the foot draws the
 * Confirm while it names the row, and the harness's `onWrite` clears it when it matches BEFORE running the call — the page's own order, so the Confirm is gone
 * before the POST is answered. The calls really POST through `prs-api`, and the stub `fetch` records url and body, so a write that went to the wrong route
 * or carried the wrong PR's head fails on the body, not just on a count.
 *
 * Fixtures discriminate: two rows in one case are two repos, two numbers, two head SHAs and two bases, so a key wired to the wrong row cannot pass.
 */

const SHA5 = '5a'.repeat(20);
const SHA6 = '6b'.repeat(20);

function repo(name: string, over: Partial<PrRepoView> = {}): PrRepoView {
  return {
    repo: name,
    polledAt: '2026-10-29T11:59:50Z',
    access: 'ok',
    detail: null,
    syncOff: null,
    methods: ['squash', 'merge'],
    autoMergeAllowed: true,
    prs: [],
    total: 0,
    truncated: false,
    ...over
  };
}

function pr(over: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 5,
    title: 'title 5',
    url: 'https://github.com/futin/x/pull/5',
    author: 'ana',
    draft: false,
    head: 'feature/5',
    headSha: SHA5,
    base: 'main',
    crossRepository: false,
    maintainerCanModify: true,
    updatedAt: '2026-10-29T11:59:00Z',
    mergeable: 'mergeable',
    mergeState: 'clean',
    review: null,
    checks: 'success',
    autoMerge: null,
    canUpdateBranch: true,
    ...over
  };
}

interface Row {
  repo: PrRepoView;
  pr: PullRequestRow;
  outcome?: PrOutcome;
  updating?: boolean;
  omitUpdatingReason?: boolean;
}

/** `futin/x#5` into `main`, head `SHA5`. */
const x5 = (over: Partial<PullRequestRow> = {}, repoOver: Partial<PrRepoView> = {}): Row => ({ repo: repo('futin/x', repoOver), pr: pr(over) });

/** `futin/y#6` into `develop`, head `SHA6` — the second row a case draws so a key wired to the wrong PR is caught. */
const y6 = (over: Partial<PullRequestRow> = {}, repoOver: Partial<PrRepoView> = {}): Row => ({
  repo: repo('futin/y', repoOver),
  pr: pr({ number: 6, title: 'title 6', url: 'https://github.com/futin/y/pull/6', head: 'feature/6', headSha: SHA6, base: 'develop', ...over })
});

const OK: PrWriteResult = { ok: true, outcome: 'auto-merge-enabled', pr: null, reread: true };

let posts: { url: string; body: unknown }[];
/** The `<repo>#<number>` of every `onWrite` the harness was handed, in order. */
let writes: string[];
/** When set, every POST is held unanswered until `answerAll()`, so a case can look at the page between the click and the answer. */
let hold: boolean;
let held: (() => void)[];

beforeEach(() => {
  posts = [];
  writes = [];
  hold = false;
  held = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const answer = { ok: true, status: 200, json: () => Promise.resolve(OK) } as Response;
    if (!hold) return Promise.resolve(answer);
    return new Promise<Response>((resolve) => held.push(() => resolve(answer)));
  }) as unknown as typeof fetch;
});

async function answerAll(): Promise<void> {
  await act(async () => {
    for (const answer of held.splice(0)) answer();
  });
}

/** The page, reduced to what the strip and the foot need from it: one confirming key, and a write that closes a matching Confirm before the call. */
function Harness({ rows, busy = false }: { rows: Row[]; busy?: boolean }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      {rows.map(({ repo: r, pr: p, outcome, updating = false, omitUpdatingReason }) => {
        const key = `${r.repo}#${p.number}`;
        const onWrite = async (call: () => Promise<PrWriteResult>): Promise<void> => {
          setConfirming((current) => (current === key ? null : current));
          writes.push(key);
          await call();
        };
        return (
          <div key={key} data-testid={`row-${key}`}>
            <PrActions
              repo={r}
              pr={p}
              updating={updating}
              outcome={outcome}
              busy={busy}
              onMerge={() => setConfirming(key)}
              onWrite={onWrite}
              omitUpdatingReason={omitUpdatingReason}
            />
            <PrFoot
              repo={r}
              pr={p}
              outcome={outcome}
              updating={updating}
              confirming={confirming === key}
              onDismiss={() => setConfirming(null)}
              onWrite={onWrite}
            />
          </div>
        );
      })}
    </>
  );
}

const strip = (key: string) => screen.getByTestId(`pr-keys-${key}`);
const key = (k: string, name: string) => within(strip(k)).getByRole('button', { name });
const openLink = (k: string) => within(strip(k)).getByRole('link', { name: 'Open ↗' });
const why = (k: string) => screen.getByTestId(`row-${k}`).querySelector('.prs-why');

/** The element a control's `aria-describedby` points at, or `null`. */
function description(el: HTMLElement): HTMLElement | null {
  const id = el.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id);
}

describe('PrActions — the four keys', () => {
  it('draws Merge, Auto-merge, Update and Open ↗ in that order, Open ↗ a link to the PR in a new tab', () => {
    render(<Harness rows={[x5()]} />);
    const root = strip('futin/x#5');
    expect(root).toHaveClass('prs-keys-side');
    const keys = root.querySelector('.prs-keys');
    expect(keys).not.toBeNull();
    expect([...keys!.querySelectorAll('.ui-chip')]).toEqual([
      key('futin/x#5', 'Merge'),
      key('futin/x#5', 'Auto-merge'),
      key('futin/x#5', 'Update'),
      openLink('futin/x#5')
    ]);
    expect(openLink('futin/x#5')).toHaveAttribute('href', 'https://github.com/futin/x/pull/5');
    expect(openLink('futin/x#5')).toHaveAttribute('target', '_blank');
    // An open key carries none of the blocked key's attributes.
    expect(key('futin/x#5', 'Merge')).not.toHaveAttribute('aria-disabled');
    expect(key('futin/x#5', 'Merge')).not.toHaveAttribute('aria-describedby');
  });

  it('fills the primary key ink and leaves the rest outline — Update on a behind PR, Merge on a clean one, none on a failing one', () => {
    render(<Harness rows={[x5({ mergeState: 'behind' }), y6({ checks: 'failure' }), { ...x5(), repo: repo('futin/z') }]} />);
    expect(key('futin/x#5', 'Update')).toHaveClass('ui-chip-ink');
    for (const name of ['Merge', 'Auto-merge']) expect(key('futin/x#5', name)).toHaveClass('ui-chip-outline');
    expect(openLink('futin/x#5')).toHaveClass('ui-chip-outline');
    expect(strip('futin/y#6').querySelector('.ui-chip-ink')).toBeNull();
    expect(key('futin/z#5', 'Merge')).toHaveClass('ui-chip-ink');
    expect(key('futin/z#5', 'Update')).toHaveClass('ui-chip-outline');
  });
});

describe('PrActions + PrFoot — the merge Confirm', () => {
  it('opens under its own row with the method Select and the question, and accept posts once with the picked method and head SHA', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5(), y6()]} />);
    await user.click(key('futin/x#5', 'Merge'));
    expect(screen.getAllByTestId('pr-merge-confirm')).toHaveLength(1);
    const confirm = within(screen.getByTestId('row-futin/x#5')).getByTestId('pr-merge-confirm');
    expect(confirm).toHaveTextContent('Merge #5 into main?');
    const select = within(confirm).getByRole<HTMLSelectElement>('combobox', { name: 'Merge method' });
    expect(within(select).getAllByRole<HTMLOptionElement>('option').map((o) => o.value)).toEqual(['squash', 'merge']);
    expect(select.value).toBe('squash');
    // Merge does not swap the strip: the key is still there, unchanged.
    expect(key('futin/x#5', 'Merge')).toBeInTheDocument();
    expect(posts).toEqual([]);

    await user.selectOptions(select, 'merge');
    hold = true;
    await user.click(within(confirm).getByTestId('pr-merge-confirm-accept'));
    // The write left the row, so the Confirm is gone while the POST is still unanswered.
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([{ url: '/api/prs/merge', body: { repo: 'futin/x', number: 5, method: 'merge', headSha: SHA5 } }]);
    expect(writes).toEqual(['futin/x#5']);
    await answerAll();
    expect(posts).toHaveLength(1);
  });

  it('sends nothing on Cancel or Escape, and either closes the Confirm', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5()]} />);
    await user.click(key('futin/x#5', 'Merge'));
    await user.click(screen.getByTestId('pr-merge-confirm-dismiss'));
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    await user.click(key('futin/x#5', 'Merge'));
    expect(screen.getByTestId('pr-merge-confirm')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('keeps one Confirm when Merge is clicked twice', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5()]} />);
    await user.click(key('futin/x#5', 'Merge'));
    await user.click(key('futin/x#5', 'Merge'));
    expect(screen.getAllByTestId('pr-merge-confirm')).toHaveLength(1);
  });

  it('closes the open Confirm when Auto-merge is clicked, sending one auto-merge POST and no merge', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5()]} />);
    await user.click(key('futin/x#5', 'Merge'));
    await user.click(key('futin/x#5', 'Auto-merge'));
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([{ url: '/api/prs/auto-merge', body: { repo: 'futin/x', number: 5, enable: true, method: 'squash' } }]);
  });
});

describe('PrActions — blocked keys and the why-line', () => {
  it('failing checks: Merge is aria-disabled with its reason as title and description, no why-line, and a click opens nothing', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ checks: 'failure' })]} />);
    const merge = key('futin/x#5', 'Merge');
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    expect(merge).not.toHaveAttribute('disabled');
    expect(merge).toHaveAttribute('title', 'checks failing');
    expect(description(merge)).toHaveTextContent(/^checks failing$/);
    expect(description(merge)).toHaveClass('sr-only');
    expect(why('futin/x#5')).toBeNull();
    await user.click(merge);
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('a repo without auto-merge says so on the why-line, and Auto-merge is aria-disabled', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({}, { autoMergeAllowed: false })]} />);
    expect(why('futin/x#5')).toHaveTextContent(/^auto-merge not enabled on the repo$/);
    const auto = key('futin/x#5', 'Auto-merge');
    expect(auto).toHaveAttribute('aria-disabled', 'true');
    expect(auto).toHaveAttribute('title', 'auto-merge not enabled on the repo');
    await user.click(auto);
    expect(posts).toEqual([]);
  });

  it('sync off blocks the three buttons with `sync off`, says it once on the why-line, and leaves Open ↗ a link', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ mergeState: 'behind' }, { syncOff: 'sync is off for futin/x — turn it on in GitHub › Settings' })]} />);
    for (const name of ['Merge', 'Auto-merge', 'Update']) {
      const k = key('futin/x#5', name);
      expect(k).toHaveAttribute('aria-disabled', 'true');
      expect(k).toHaveAttribute('title', 'sync off');
      expect(description(k)).toHaveTextContent(/^sync off$/);
      await user.click(k);
    }
    expect(why('futin/x#5')).toHaveTextContent(/^sync off$/);
    expect(openLink('futin/x#5')).toHaveAttribute('href', 'https://github.com/futin/x/pull/5');
    expect(openLink('futin/x#5')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('leaves updating… off the why-line with omitUpdatingReason, and says it without', () => {
    render(<Harness rows={[{ ...x5(), updating: true, omitUpdatingReason: true }, { ...y6(), updating: true }]} />);
    expect(why('futin/x#5')).toBeNull();
    expect(why('futin/y#6')).toHaveTextContent(/^updating…$/);
  });
});

describe('PrActions — Auto-merge and Update', () => {
  it('arms an unarmed PR with the default method, and sends no method when the repo allows none', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5(), y6({}, { methods: [] })]} />);
    const auto = key('futin/x#5', 'Auto-merge');
    expect(auto).toHaveAttribute('aria-pressed', 'false');
    await user.click(auto);
    await user.click(key('futin/y#6', 'Auto-merge'));
    expect(posts).toEqual([
      { url: '/api/prs/auto-merge', body: { repo: 'futin/x', number: 5, enable: true, method: 'squash' } },
      { url: '/api/prs/auto-merge', body: { repo: 'futin/y', number: 6, enable: true } }
    ]);
  });

  it('reads Auto-merge ✓ on an armed PR, named Auto-merge and pressed, and disarms it even with failing checks', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ checks: 'failure', autoMerge: { method: 'merge', enabledAt: '2026-10-29T11:00:00Z' } })]} />);
    const auto = key('futin/x#5', 'Auto-merge');
    expect(auto).toHaveTextContent('Auto-merge ✓');
    expect(auto).toHaveAttribute('aria-pressed', 'true');
    expect(auto).not.toHaveAttribute('aria-disabled');
    await user.click(auto);
    expect(posts).toEqual([{ url: '/api/prs/auto-merge', body: { repo: 'futin/x', number: 5, enable: false } }]);
  });

  it('updates a behind PR with one POST of its own head, and holds Update aria-disabled while the PR is updating', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ mergeState: 'behind' }), { ...y6({ mergeState: 'behind' }), updating: true }]} />);
    await user.click(key('futin/x#5', 'Update'));
    expect(posts).toEqual([{ url: '/api/prs/update-branch', body: { repo: 'futin/x', number: 5, headSha: SHA5 } }]);
    const update = key('futin/y#6', 'Update');
    expect(update).toHaveAttribute('aria-disabled', 'true');
    expect(update).toHaveAttribute('title', 'updating…');
    expect(update).not.toHaveClass('ui-chip-ink');
    await user.click(update);
    expect(posts).toHaveLength(1);
  });
});

describe('PrActions — a write in flight', () => {
  it('disables the three buttons but never Open ↗ while busy, and frees them when it is not', () => {
    const { rerender } = render(<Harness rows={[x5({ mergeState: 'behind' })]} busy />);
    for (const name of ['Merge', 'Auto-merge', 'Update']) expect(key('futin/x#5', name)).toBeDisabled();
    expect(openLink('futin/x#5')).not.toHaveAttribute('disabled');
    rerender(<Harness rows={[x5({ mergeState: 'behind' })]} busy={false} />);
    for (const name of ['Merge', 'Auto-merge', 'Update']) expect(key('futin/x#5', name)).toBeEnabled();
  });
});

describe('PrFoot', () => {
  it('draws the outcome line under the row when no Confirm is open', () => {
    render(<Harness rows={[{ ...x5(), outcome: { kind: 'ok', text: 'auto-merge armed' } }]} />);
    const foot = screen.getByTestId('row-futin/x#5').querySelector('.prs-foot');
    expect(foot).not.toBeNull();
    expect(within(foot as HTMLElement).getByTestId('pr-outcome')).toHaveTextContent('auto-merge armed');
  });

  it('renders nothing at all for an expired updating outcome, or a Confirm whose merge is blocked', () => {
    const props = { repo: repo('futin/x'), onDismiss: jest.fn(), onWrite: jest.fn(() => Promise.resolve()) };
    const { container, rerender } = render(
      <PrFoot {...props} pr={pr()} outcome={{ kind: 'updating', text: 'updating…' }} updating={false} confirming={false} />
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<PrFoot {...props} pr={pr({ checks: 'failure' })} outcome={undefined} updating={false} confirming />);
    expect(container).toBeEmptyDOMElement();
  });

  it('accept hands the merge to onWrite once and closes nothing itself, sending the repo default once the picked method is no longer allowed', async () => {
    const user = userEvent.setup();
    const onDismiss = jest.fn();
    const onWrite = jest.fn(async (call: () => Promise<PrWriteResult>): Promise<void> => {
      await call();
    });
    const first = repo('futin/x', { methods: ['squash', 'merge', 'rebase'] });
    const { rerender } = render(<PrFoot repo={first} pr={pr()} outcome={undefined} updating={false} confirming onDismiss={onDismiss} onWrite={onWrite} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Merge method' }), 'rebase');
    // A repo setting changed on github.com between two reads: the stale pick falls back to the default rather than sending a method GitHub would refuse.
    rerender(<PrFoot repo={repo('futin/x')} pr={pr()} outcome={undefined} updating={false} confirming onDismiss={onDismiss} onWrite={onWrite} />);
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Merge method' }).value).toBe('squash');
    await user.click(screen.getByTestId('pr-merge-confirm-accept'));
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(posts).toEqual([{ url: '/api/prs/merge', body: { repo: 'futin/x', number: 5, method: 'squash', headSha: SHA5 } }]);
  });
});

describe('PrOutcomeLine', () => {
  it('renders nothing for an updating outcome once the mark has expired, and nothing for no outcome', () => {
    const { container, rerender } = render(<PrOutcomeLine outcome={{ kind: 'updating', text: 'updating…' }} updating={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PrOutcomeLine outcome={undefined} updating={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an updating outcome while it is updating, and an error in the error class', () => {
    const { rerender } = render(<PrOutcomeLine outcome={{ kind: 'updating', text: 'updating…' }} updating />);
    expect(screen.getByRole('status')).toHaveTextContent('updating…');
    rerender(<PrOutcomeLine outcome={{ kind: 'error', text: 'GitHub said no' }} updating={false} />);
    expect(screen.getByTestId('pr-outcome')).toHaveClass('prs-outcome-error');
  });
});
