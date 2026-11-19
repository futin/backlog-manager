import { useEffect, useState } from 'react';

/**
 * persistedStore / persistedJsonStore — the one home of the client's persisted module store: one value (a closed string for `persistedStore`, any JSON the reader accepts for `persistedJsonStore`), one `localStorage` key, every mounted reader subscribed.
 * `useFilesPage`, `useGithubPage`, `useJiraPage`, `useRunsMode` and `useJiraView` are all this, and each keeps only what is its own: the key, the guard, the
 * fallback and the reason it has more than one mounted reader. Four hand copies of this body were four things free to drift, and audits kept reporting them
 * (#425). `useJiraDetailTab`, `useJiraTicketKey` and `useIgnoredSteps` (Jira detail tabs spec §1.3, §2.1, §4.5.1) are the same body over `persistedJsonStore`
 * below: the two closed-string ones through the same guard-and-fallback, the ignore store through a repairing reader of an object.
 *
 * **Why a module store and not `usePersistedState`.** That hook is a `useState` per caller over one key, so a write from one mounted component would reach
 * localStorage and never reach another already-mounted one: the rail's tree would persist a page the view beside it went on ignoring until a reload. Holding
 * the subscribers once, at module level, is the smallest thing that makes "they are looking at the same value" true by construction rather than by two
 * components happening to re-mount at the right moment.
 *
 * **Mounted readers, and NOT a cached value beside them.** Storage is read on every mount, exactly as `usePersistedState` does, so the store holds no value
 * that could outlive a `localStorage.clear()`: a cache here would make one test's stored value leak into the next one's first render, and make a second browser
 * tab's write invisible to this one. What the set adds over `usePersistedState` is only the part that was missing, a write reaching every mounted reader and
 * not just the one that made it. `useJiraListFilters` looks like the same thing and is not: nothing in it is persisted, and it caches its value on purpose.
 *
 * Reads go through the guard on the way out of storage, because localStorage can hand back anything at all: absent, not JSON, a word this build never had. All
 * of those read as `fallback`. A caller holds nothing else at module level, and its key, member list and guard stay in its own React-free `lib/` file.
 */
export function persistedJsonStore<T>(key: string, read: (v: unknown) => T) {
  type Listener = (v: T) => void;
  const listeners = new Set<Listener>();

  /**
   * `read` always gets what `JSON.parse` produced, and `null` for anything that is not there to parse: absent, not JSON, or storage that throws. So a reader
   * decides what a bad value means in one place and is never handed the raw text of a value that merely LOOKS like a member (an unquoted `board`).
   */
  const readStored = (): T => {
    let parsed: unknown = null;
    try {
      const raw = localStorage.getItem(key);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // Private mode, or a stored value that is not JSON at all.
      parsed = null;
    }
    return read(parsed);
  };

  const set = (value: T): void => {
    try {
      // JSON, the way `usePersistedState` writes every other key.
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore: private mode / quota — the in-memory value still moves */
    }
    for (const l of listeners) l(value);
  };

  const useValue = (): T => {
    const [value, setValue] = useState<T>(readStored);
    useEffect(() => {
      listeners.add(setValue);
      return () => {
        listeners.delete(setValue);
      };
    }, []);
    return value;
  };

  return { useValue, set };
}

/**
 * The closed-string store: `persistedJsonStore` with a membership guard and a fallback as its reader. `useValue` keeps returning `[value, set]`, the tuple
 * every existing caller destructures.
 */
export function persistedStore<V extends string>(key: string, isValue: (v: unknown) => v is V, fallback: V) {
  const store = persistedJsonStore<V>(key, (v) => (isValue(v) ? v : fallback));
  const useValue = (): [V, (v: V) => void] => [store.useValue(), store.set];
  return { useValue, set: store.set };
}
