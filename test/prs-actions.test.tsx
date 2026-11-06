/**
 * @jest-environment jsdom
 */
import { useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { Glyph, type GlyphName } from '../client/src/components/ui/Glyphs';
import { PrActions } from '../client/src/components/github/PrActions';
import { PrFoot } from '../client/src/components/github/PrFoot';
import { PrOutcomeLine } from '../client/src/components/github/PrOutcomeLine';
import type { PrOutcome } from '../client/src/lib/prs';
import { mainOf, moreOf, openOf, type MenuRowName } from './helpers/pr-keys';
import type { PrRepoView, PrWriteResult, PullRequestRow } from '../shared/types';

/** A glyph's markup, rendered into a detached container (`Glyph` carries no name attribute, and `react-dom/server` needs TextEncoder, which jsdom lacks). */
const glyphSvg = (name: GlyphName): string => render(<Glyph name={name} />, { container: document.createElement('div') }).container.innerHTML;

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
    checksDetail: null,
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
    checkCounts: null,
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
function Harness({ rows, busy = false, blockedText = false }: { rows: Row[]; busy?: boolean; blockedText?: boolean }) {
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
              blockedText={blockedText}
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
/** The main half of the split Merge: `Merge #n`, `Auto-merge #n` or `Auto-merge on #n`, whichever `mergeMain` says. */
const main = (k: string) => mainOf(strip(k));
/** The chevron: `Merge options for #n`. */
const more = (k: string) => moreOf(strip(k));
const openLink = (k: string) => openOf(strip(k));
const menu = (k: string) => within(strip(k)).getByRole('dialog', { name: 'Merge menu' });
/** Opens the Merge menu of a row and presses one of its rows, the way a person does. */
async function pick(user: ReturnType<typeof userEvent.setup>, k: string, row: MenuRowName): Promise<void> {
  await user.click(more(k));
  await user.click(within(menu(k)).getByRole('button', { name: row }));
}
const why = (k: string) => screen.getByTestId(`row-${k}`).querySelector('.prs-why');

/** The element a control's `aria-describedby` points at, or `null`. */
function description(el: HTMLElement): HTMLElement | null {
  const id = el.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id);
}

describe('PrActions — the split Merge', () => {
  it('draws the split Merge and the Open link, in that order, the link to the PR in a new tab with no referrer', () => {
    render(<Harness rows={[x5()]} />);
    const root = strip('futin/x#5');
    expect(root).toHaveClass('prs-keys-side');
    const keys = root.querySelector('.prs-keys');
    expect(keys).not.toBeNull();
    expect([...keys!.children].map((el) => el.className.split(' ')[0])).toEqual(['prs-keys-merge', 'ui-chip']);
    expect(within(keys!.firstElementChild as HTMLElement).getByRole('group')).toHaveClass('ui-split');
    expect(openLink('futin/x#5')).toHaveAttribute('href', 'https://github.com/futin/x/pull/5');
    expect(openLink('futin/x#5')).toHaveAttribute('target', '_blank');
    expect(openLink('futin/x#5')).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(openLink('futin/x#5')).not.toHaveAttribute('aria-disabled');
    // The main half is open: none of a blocked half's attributes.
    expect(main('futin/x#5')).toHaveTextContent('Merge');
    expect(main('futin/x#5')).not.toHaveAttribute('aria-disabled');
    expect(main('futin/x#5')).not.toHaveAttribute('aria-describedby');
    expect(more('futin/x#5')).toHaveAttribute('aria-expanded', 'false');
  });

  it('fills the main half ink and ticks the primary row — Update branch on a behind PR, Merge on a clean one, nothing on a failing one', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ mergeState: 'behind' }), y6({ checks: 'failure' }), { ...x5(), repo: repo('futin/z') }]} />);
    expect(strip('futin/x#5').querySelector('.ui-split')).toHaveClass('ui-split-outline');
    expect(strip('futin/z#5').querySelector('.ui-split')).not.toHaveClass('ui-split-outline');
    await user.click(more('futin/x#5'));
    expect(menu('futin/x#5').querySelectorAll('.prs-keys-tick')).toHaveLength(1);
    expect(within(menu('futin/x#5')).getByRole('button', { name: 'Update branch' }).querySelector('.prs-keys-tick')).toHaveAttribute('aria-hidden', 'true');
    await user.click(more('futin/z#5'));
    expect(within(menu('futin/z#5')).getByRole('button', { name: 'Merge' }).querySelector('.prs-keys-tick')).not.toBeNull();
    expect(within(menu('futin/z#5')).getByRole('button', { name: 'Update branch' }).querySelector('.prs-keys-tick')).toBeNull();
    await user.click(more('futin/y#6'));
    expect(menu('futin/y#6').querySelector('.prs-keys-tick')).toBeNull();
    expect(strip('futin/y#6').querySelector('.ui-split')).toHaveClass('ui-split-dashed');
    // Dashed alone: the outline skin's later rules would repaint the border solid and the word in ink.
    expect(strip('futin/y#6').querySelector('.ui-split')).not.toHaveClass('ui-split-outline');
  });

  it('draws each menu row\'s mark as a 28 px tile — Merge green, auto-merge and Update neutral — and only the primary row carries the at-rest ground', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ mergeState: 'behind' }), { ...x5(), repo: repo('futin/z') }, y6({ checks: 'failure' })]} />);
    const tile = (k: string, row: MenuRowName) => within(menu(k)).getByRole('button', { name: row }).querySelector('.ui-glyph-tile');
    await user.click(more('futin/z#5'));
    expect(tile('futin/z#5', 'Merge')).toHaveAttribute('data-size', '28');
    expect(tile('futin/z#5', 'Merge')).toHaveAttribute('data-tone', 'green');
    expect(tile('futin/z#5', 'Enable auto-merge')).toHaveAttribute('data-size', '28');
    expect(tile('futin/z#5', 'Enable auto-merge')).toHaveAttribute('data-tone', 'neutral');
    expect(tile('futin/z#5', 'Update branch')).toHaveAttribute('data-size', '28');
    expect(tile('futin/z#5', 'Update branch')).toHaveAttribute('data-tone', 'neutral');
    // The mock draws an up arrow for Update branch (ui-verify D5), not the refresh mark: compared by markup, since `Glyph` carries no name attribute.
    expect(tile('futin/z#5', 'Update branch')?.querySelector('svg')?.outerHTML).toBe(glyphSvg('up'));
    expect(tile('futin/z#5', 'Update branch')?.querySelector('svg')?.outerHTML).not.toBe(glyphSvg('refresh'));
    // The mock's `.mi.on`: the primary row sits on the `--strip-hi` ground at rest, beside its tick — and no other row does.
    const on = (k: string) => [...menu(k).querySelectorAll('.prs-keys-row-on')].map((el) => el.textContent);
    expect(on('futin/z#5')).toHaveLength(1);
    expect(within(menu('futin/z#5')).getByRole('button', { name: 'Merge' })).toHaveClass('prs-keys-row-on');
    await user.click(more('futin/x#5'));
    expect(within(menu('futin/x#5')).getByRole('button', { name: 'Update branch' })).toHaveClass('prs-keys-row-on');
    expect(on('futin/x#5')).toHaveLength(1);
    // A failing PR has no primary (no tick), so no row is on, and the blocked rows are still aria-disabled.
    await user.click(more('futin/y#6'));
    expect(on('futin/y#6')).toHaveLength(0);
    expect(within(menu('futin/y#6')).getByRole('button', { name: 'Merge' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu('futin/y#6')).getByRole('button', { name: 'Merge' }).querySelector('.ui-glyph-tile')).toHaveAttribute('data-size', '28');
  });

  it('names the main half by its mode: Merge #12, Auto-merge #12 while checks run, Auto-merge on #12 once armed', () => {
    const armed = { method: 'squash' as const, enabledAt: '2026-10-29T11:00:00Z' };
    render(
      <Harness
        rows={[
          x5({ number: 12, url: 'https://github.com/futin/x/pull/12' }),
          { ...x5({ number: 13, checks: 'pending' }), repo: repo('futin/p') },
          { ...x5({ number: 14, autoMerge: armed }), repo: repo('futin/q') }
        ]}
      />
    );
    expect(main('futin/x#12')).toHaveTextContent(/^Merge$/);
    expect(more('futin/x#12')).toHaveAccessibleName('Merge options for #12');
    expect(main('futin/p#13')).toHaveAccessibleName('Auto-merge #13');
    expect(main('futin/p#13')).toHaveTextContent(/^Auto-merge$/);
    expect(main('futin/q#14')).toHaveAccessibleName('Auto-merge on #14');
    expect(main('futin/q#14')).toHaveTextContent(/^Auto-merge on$/);
    expect(main('futin/q#14')).toBeEnabled();
    expect(main('futin/q#14')).not.toHaveAttribute('aria-disabled');
    expect(openLink('futin/x#12')).toHaveAccessibleName('Open #12 on GitHub');
  });

  it('opens the menu with exactly Merge, Enable auto-merge and Update branch, focus on the first, and Escape closes it back onto the chevron', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ mergeState: 'behind' })]} />);
    expect(screen.queryByRole('dialog', { name: 'Merge menu' })).toBeNull();
    await user.click(more('futin/x#5'));
    expect(more('futin/x#5')).toHaveAttribute('aria-expanded', 'true');
    const rows = within(menu('futin/x#5')).getAllByRole('button');
    expect(rows.map((b) => b.getAttribute('aria-labelledby') && document.getElementById(b.getAttribute('aria-labelledby')!)?.textContent)).toEqual([
      'Merge',
      'Enable auto-merge',
      'Update branch'
    ]);
    expect(menu('futin/x#5')).toHaveTextContent('asks first, then merges into main');
    expect(menu('futin/x#5')).toHaveTextContent('GitHub merges when checks pass');
    expect(menu('futin/x#5')).toHaveTextContent('merge main into feature/5');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Merge menu' })).toBeNull();
    expect(more('futin/x#5')).toHaveFocus();
  });

  it('lands focus on the first ENABLED row when the first is blocked', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ checks: 'failure' })]} />);
    await user.click(more('futin/x#5'));
    expect(within(menu('futin/x#5')).getByRole('button', { name: 'Merge' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu('futin/x#5')).getByRole('button', { name: 'Update branch' })).toHaveFocus();
  });
});

describe('PrActions + PrFoot — the merge Confirm', () => {
  it('Merge #n opens under its own row with the method Select and the question, and accept posts once with the picked method and head SHA', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5(), y6()]} />);
    expect(main('futin/x#5')).toHaveAccessibleName('Merge #5');
    await user.click(main('futin/x#5'));
    expect(screen.getAllByTestId('pr-merge-confirm')).toHaveLength(1);
    const confirm = within(screen.getByTestId('row-futin/x#5')).getByTestId('pr-merge-confirm');
    expect(confirm).toHaveTextContent('Merge #5 into main?');
    const select = within(confirm).getByRole<HTMLSelectElement>('combobox', { name: 'Merge method' });
    expect(within(select).getAllByRole<HTMLOptionElement>('option').map((o) => o.value)).toEqual(['squash', 'merge']);
    expect(select.value).toBe('squash');
    // Merge does not swap the strip: the main half is still there, unchanged.
    expect(main('futin/x#5')).toBeInTheDocument();
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

  it('the menu\'s Merge row asks the same question and closes the menu, leaving focus to the Confirm\'s safe answer', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5()]} />);
    await pick(user, 'futin/x#5', 'Merge');
    expect(screen.getByTestId('pr-merge-confirm')).toHaveTextContent('Merge #5 into main?');
    expect(screen.queryByRole('dialog', { name: 'Merge menu' })).toBeNull();
    // The row hands focus to the chevron, and the Confirm that mounts in the same beat takes it for its safe answer (`Confirm`'s own rule), so it ends there.
    expect(screen.getByTestId('pr-merge-confirm-dismiss')).toHaveFocus();
    expect(posts).toEqual([]);
  });

  it('sends nothing on Cancel or Escape, and either closes the Confirm', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5()]} />);
    await user.click(main('futin/x#5'));
    await user.click(screen.getByTestId('pr-merge-confirm-dismiss'));
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    await user.click(main('futin/x#5'));
    expect(screen.getByTestId('pr-merge-confirm')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('keeps one Confirm when Merge is clicked twice', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5()]} />);
    await user.click(main('futin/x#5'));
    await user.click(main('futin/x#5'));
    expect(screen.getAllByTestId('pr-merge-confirm')).toHaveLength(1);
  });

  it('closes the open Confirm when Enable auto-merge is picked, sending one auto-merge POST and no merge', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5()]} />);
    await user.click(main('futin/x#5'));
    await pick(user, 'futin/x#5', 'Enable auto-merge');
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([{ url: '/api/prs/auto-merge', body: { repo: 'futin/x', number: 5, enable: true, method: 'squash' } }]);
  });
});

describe('PrActions — blocked halves and the why-line', () => {
  it('failing checks: the main half reads Blocked, aria-disabled, titled and described by its reason, and a click opens nothing; the chevron still opens', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ checks: 'failure' })]} />);
    const merge = main('futin/x#5');
    expect(merge).toHaveTextContent(/^Blocked$/);
    expect(merge).toHaveAccessibleName('Merge #5');
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    expect(merge).not.toHaveAttribute('disabled');
    expect(merge).toHaveAttribute('title', 'checks failing');
    expect(description(merge)).toHaveTextContent(/^checks failing$/);
    expect(description(merge)).toHaveClass('sr-only');
    expect(strip('futin/x#5').querySelector('.ui-split')).toHaveClass('ui-split-dashed');
    expect(why('futin/x#5')).toBeNull();
    await user.click(merge);
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([]);
    expect(more('futin/x#5')).toBeEnabled();
    await user.click(more('futin/x#5'));
    const rows = within(menu('futin/x#5')).getAllByRole('button');
    expect(rows.map((b) => document.getElementById(b.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['Merge', 'Enable auto-merge', 'Update branch']);
    // Merge and Enable auto-merge share the PR's own reason; Update branch is open.
    expect(rows[0]).toHaveAttribute('aria-disabled', 'true');
    expect(rows[1]).toHaveAttribute('aria-disabled', 'true');
    expect(rows[2]).not.toHaveAttribute('aria-disabled');
    expect(description(rows[0])).toHaveTextContent(/^checks failing$/);
    expect(rows[0]).not.toHaveTextContent('asks first');
  });

  it('a repo without auto-merge says so on the why-line, and the Enable auto-merge row is aria-disabled with the reason as its sub-line', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({}, { autoMergeAllowed: false })]} />);
    expect(why('futin/x#5')).toHaveTextContent(/^auto-merge not enabled on the repo$/);
    await user.click(more('futin/x#5'));
    const auto = within(menu('futin/x#5')).getByRole('button', { name: 'Enable auto-merge' });
    expect(auto).toHaveAttribute('aria-disabled', 'true');
    expect(description(auto)).toHaveTextContent(/^auto-merge not enabled on the repo$/);
    expect(auto).not.toHaveTextContent('GitHub merges when checks pass');
    await user.click(auto);
    expect(posts).toEqual([]);
    // A blocked row keeps the menu open: nothing was picked.
    expect(screen.getByRole('dialog', { name: 'Merge menu' })).toBeInTheDocument();
  });

  it('sync off blocks the main half and every menu row with `sync off`, says it once on the why-line, and leaves Open a link', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ mergeState: 'behind' }, { syncOff: 'sync is off for futin/x — turn it on in GitHub › Settings' })]} />);
    const m = main('futin/x#5');
    expect(m).toHaveAttribute('aria-disabled', 'true');
    expect(m).toHaveAttribute('title', 'sync off');
    expect(description(m)).toHaveTextContent(/^sync off$/);
    await user.click(m);
    await user.click(more('futin/x#5'));
    for (const name of ['Merge', 'Enable auto-merge', 'Update branch'] as const) {
      const r = within(menu('futin/x#5')).getByRole('button', { name });
      expect(r).toHaveAttribute('aria-disabled', 'true');
      expect(description(r)).toHaveTextContent(/^sync off$/);
      await user.click(r);
    }
    expect(why('futin/x#5')).toHaveTextContent(/^sync off$/);
    expect(openLink('futin/x#5')).toHaveAttribute('href', 'https://github.com/futin/x/pull/5');
    expect(openLink('futin/x#5')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('an armed PR on a sync-off repo keeps its name, Auto-merge on #12, but reads Blocked and sends nothing; Disable auto-merge is blocked too', async () => {
    const user = userEvent.setup();
    const armed = { method: 'squash' as const, enabledAt: '2026-10-29T11:00:00Z' };
    render(<Harness rows={[x5({ number: 12, autoMerge: armed }, { syncOff: 'sync is off for futin/x' })]} />);
    const m = main('futin/x#12');
    expect(m).toHaveAccessibleName('Auto-merge on #12');
    expect(m).toHaveTextContent(/^Blocked$/);
    expect(m).toHaveAttribute('aria-disabled', 'true');
    expect(m).toHaveAttribute('title', 'sync off');
    await user.click(m);
    expect(posts).toEqual([]);
    expect(more('futin/x#12')).toBeEnabled();
    await user.click(more('futin/x#12'));
    for (const name of ['Merge', 'Disable auto-merge', 'Update branch'] as const) {
      const r = within(menu('futin/x#12')).getByRole('button', { name });
      expect(r).toHaveAttribute('aria-disabled', 'true');
      expect(description(r)).toHaveTextContent(/^sync off$/);
    }
  });

  it('shows the reason in place of Blocked with blockedText', () => {
    render(<Harness rows={[x5({ checks: 'failure' })]} blockedText />);
    expect(main('futin/x#5')).toHaveTextContent(/^checks failing$/);
    expect(main('futin/x#5')).toHaveAttribute('aria-disabled', 'true');
  });

  it('leaves updating… off the why-line with omitUpdatingReason, and says it without', () => {
    render(<Harness rows={[{ ...x5(), updating: true, omitUpdatingReason: true }, { ...y6(), updating: true }]} />);
    expect(why('futin/x#5')).toBeNull();
    expect(why('futin/y#6')).toHaveTextContent(/^updating…$/);
  });
});

describe('PrActions — auto-merge and Update branch', () => {
  it('while checks run, the main half arms with the default method, and sends no method when the repo allows none', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ checks: 'pending' }), y6({ checks: 'pending' }, { methods: [] })]} />);
    expect(main('futin/x#5')).toHaveAccessibleName('Auto-merge #5');
    await user.click(main('futin/x#5'));
    await user.click(main('futin/y#6'));
    expect(posts).toEqual([
      { url: '/api/prs/auto-merge', body: { repo: 'futin/x', number: 5, enable: true, method: 'squash' } },
      { url: '/api/prs/auto-merge', body: { repo: 'futin/y', number: 6, enable: true } }
    ]);
    expect(screen.queryByTestId('pr-merge-confirm')).not.toBeInTheDocument();
  });

  it('Enable auto-merge arms a passing PR with the default method, and sends no method when the repo allows none', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5(), y6({}, { methods: [] })]} />);
    await pick(user, 'futin/x#5', 'Enable auto-merge');
    await pick(user, 'futin/y#6', 'Enable auto-merge');
    expect(posts).toEqual([
      { url: '/api/prs/auto-merge', body: { repo: 'futin/x', number: 5, enable: true, method: 'squash' } },
      { url: '/api/prs/auto-merge', body: { repo: 'futin/y', number: 6, enable: true } }
    ]);
  });

  it('an armed PR reads Auto-merge on #5, enabled, disarms with one POST even with failing checks, and the menu row reads Disable auto-merge', async () => {
    const user = userEvent.setup();
    const armed = { method: 'merge' as const, enabledAt: '2026-10-29T11:00:00Z' };
    render(<Harness rows={[x5({ checks: 'failure', autoMerge: armed }), y6({ autoMerge: armed })]} />);
    const m = main('futin/x#5');
    expect(m).toHaveAccessibleName('Auto-merge on #5');
    expect(m).toBeEnabled();
    expect(m).not.toHaveAttribute('aria-disabled');
    await user.click(m);
    expect(posts).toEqual([{ url: '/api/prs/auto-merge', body: { repo: 'futin/x', number: 5, enable: false } }]);
    await user.click(more('futin/y#6'));
    expect(within(menu('futin/y#6')).queryByRole('button', { name: 'Enable auto-merge' })).toBeNull();
    expect(menu('futin/y#6')).toHaveTextContent('GitHub stops waiting to merge');
    await user.click(within(menu('futin/y#6')).getByRole('button', { name: 'Disable auto-merge' }));
    expect(posts[1]).toEqual({ url: '/api/prs/auto-merge', body: { repo: 'futin/y', number: 6, enable: false } });
    expect(screen.queryByRole('dialog', { name: 'Merge menu' })).toBeNull();
  });

  it('Update branch sends one POST of its own head, and is aria-disabled while the PR is updating', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ mergeState: 'behind' }), { ...y6({ mergeState: 'behind' }), updating: true }]} />);
    await pick(user, 'futin/x#5', 'Update branch');
    expect(posts).toEqual([{ url: '/api/prs/update-branch', body: { repo: 'futin/x', number: 5, headSha: SHA5 } }]);
    expect(more('futin/x#5')).toHaveFocus();
    await user.click(more('futin/y#6'));
    const update = within(menu('futin/y#6')).getByRole('button', { name: 'Update branch' });
    expect(update).toHaveAttribute('aria-disabled', 'true');
    expect(description(update)).toHaveTextContent(/^updating…$/);
    await user.click(update);
    expect(posts).toHaveLength(1);
  });

  it('a blocked Update branch row says why it is blocked', async () => {
    const user = userEvent.setup();
    render(<Harness rows={[x5({ canUpdateBranch: false })]} />);
    await user.click(more('futin/x#5'));
    const update = within(menu('futin/x#5')).getByRole('button', { name: 'Update branch' });
    expect(update).toHaveAttribute('aria-disabled', 'true');
    expect(description(update)).toHaveTextContent(/^already up to date$/);
  });
});

describe('PrActions — a write in flight', () => {
  it('disables the split while busy, closes an open menu, keeps Open a link, and frees the split when it is not', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness rows={[x5({ mergeState: 'behind' })]} />);
    await user.click(more('futin/x#5'));
    rerender(<Harness rows={[x5({ mergeState: 'behind' })]} busy />);
    expect(screen.queryByRole('dialog', { name: 'Merge menu' })).toBeNull();
    expect(main('futin/x#5')).toBeDisabled();
    expect(more('futin/x#5')).toBeDisabled();
    expect(openLink('futin/x#5')).not.toHaveAttribute('disabled');
    rerender(<Harness rows={[x5({ mergeState: 'behind' })]} busy={false} />);
    expect(main('futin/x#5')).toBeEnabled();
    expect(more('futin/x#5')).toBeEnabled();
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
