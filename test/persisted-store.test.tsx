/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { persistedStore } from '../client/src/hooks/persistedStore';

/*
  `persistedStore` is the one home of the client's persisted module store (#464): the subscribe, read and write body `useFilesPage`, `useGithubPage`,
  `useJiraPage`, `useRunsMode` and `useJiraView` used to carry four times over. These cases drive a throwaway store over a two-member value, so they pin the
  factory rather than any one surface — each surface's own suite still pins its key and its fallback. Storage is cleared between cases, and the store holds
  nothing else, so one case's value cannot reach the next one's first render: that is the "no cached module value" case below, stated as a precondition of every
  other case too.
*/

type Letter = 'a' | 'b';

const KEY = 'test.persisted-store';
const isLetter = (v: unknown): v is Letter => v === 'a' || v === 'b';
const store = persistedStore<Letter>(KEY, isLetter, 'a');

function Reader({ id }: { id: string }) {
  const [value, setValue] = store.useValue();
  return (
    <button onClick={() => setValue(value === 'a' ? 'b' : 'a')}>
      {id}:{value}
    </button>
  );
}

describe('persistedStore', () => {
  beforeEach(() => localStorage.clear());

  it('reads the fallback when nothing is stored', () => {
    render(<Reader id="r" />);
    expect(screen.getByRole('button', { name: 'r:a' })).toBeInTheDocument();
  });

  it('reads a stored member, in the JSON shape usePersistedState writes', () => {
    localStorage.setItem(KEY, JSON.stringify('b'));
    render(<Reader id="r" />);
    expect(screen.getByRole('button', { name: 'r:b' })).toBeInTheDocument();
  });

  it('reads the fallback for a stored value the guard refuses', () => {
    localStorage.setItem(KEY, JSON.stringify('c'));
    render(<Reader id="r" />);
    expect(screen.getByRole('button', { name: 'r:a' })).toBeInTheDocument();
  });

  it('reads the fallback for a stored value that is not JSON, without throwing', () => {
    localStorage.setItem(KEY, 'not json');
    render(<Reader id="r" />);
    expect(screen.getByRole('button', { name: 'r:a' })).toBeInTheDocument();
  });

  it('moves a second mounted reader in the same render pass as the one that wrote', async () => {
    render(
      <>
        <Reader id="one" />
        <Reader id="two" />
      </>
    );
    await userEvent.click(screen.getByRole('button', { name: 'one:a' }));
    expect(screen.getByRole('button', { name: 'one:b' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'two:b' })).toBeInTheDocument();
  });

  it('takes a set from outside React, and stores it with the JSON quotes', () => {
    render(<Reader id="r" />);
    act(() => store.set('b'));
    expect(screen.getByRole('button', { name: 'r:b' })).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe('"b"');
  });

  it('reads storage again on a fresh mount, so no module value outlives a direct write', () => {
    const { unmount } = render(<Reader id="r" />);
    act(() => store.set('b'));
    unmount();
    localStorage.setItem(KEY, JSON.stringify('a'));
    render(<Reader id="r" />);
    expect(screen.getByRole('button', { name: 'r:a' })).toBeInTheDocument();
  });

  it('still moves the mounted reader when localStorage.setItem throws', () => {
    render(<Reader id="r" />);
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => act(() => store.set('b'))).not.toThrow();
      expect(screen.getByRole('button', { name: 'r:b' })).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it('drops an unmounted reader, so a later set reaches no old setter', () => {
    // React 18 no longer warns on a set after unmount, so the observable is the listener itself: the spy stands in for the `Set`'s `delete`, and a leaked
    // listener would also keep this store's old setter alive for the rest of the tab.
    const deleted = jest.spyOn(Set.prototype, 'delete');
    const added = jest.spyOn(Set.prototype, 'add');
    try {
      const { unmount } = render(<Reader id="r" />);
      const listener = added.mock.calls.map(([fn]) => fn as unknown).find((fn) => typeof fn === 'function');
      expect(listener).toBeDefined();
      unmount();
      expect(deleted.mock.calls.map(([fn]) => fn as unknown)).toContain(listener);
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      store.set('b');
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    } finally {
      deleted.mockRestore();
      added.mockRestore();
    }
  });
});

/*
  A source guard, because behaviour cannot catch a fifth hand copy: it would work, and its tests would pass. `useJiraListFilters.ts` is the one other module
  store on purpose — nothing in it is persisted, it holds a cached module value by design, and every write goes through `clean` and merges a patch — so it stays
  on the list by name and a third file fails here until it goes through the factory, or says why not by joining this list.
*/
describe('the one persisted module store', () => {
  it('names new Set<Listener> only in persistedStore.ts and useJiraListFilters.ts under client/src/hooks', () => {
    const dir = join(__dirname, '..', 'client', 'src', 'hooks');
    const holders = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name))
      .filter((name) => readFileSync(join(dir, name), 'utf8').includes('new Set<Listener>'));
    expect(holders.sort()).toEqual(['persistedStore.ts', 'useJiraListFilters.ts']);
  });
});
