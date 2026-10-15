/**
 * Reload once when Vite cannot fetch a lazy chunk (#270).
 *
 * The sections are `lazy()` imports (App.tsx), so each one's chunk is fetched the first time it is opened — from the build that was current when the
 * tab loaded. A rebuild while the tab is open (`pnpm run build`, a `docker:sync`) replaces `dist/assets/` with new hashed names, and the next section
 * switch asks the server for a file that no longer exists. Vite reports that as a `vite:preloadError` event on `window` before rethrowing it; a full
 * reload picks up the new `index.html` and its new chunk names, which is the whole fix for the common case.
 *
 * Reloading on EVERY such event would loop forever when the chunk is missing for a reason a reload does not cure (the server is down, a broken
 * build). So the reload is guarded by a timestamp in `sessionStorage`: a preload failure within `RELOAD_GUARD_MS` of the last guarded reload is the
 * reload not having helped, and is left to propagate — the import rejects, the lazy section throws, and `SectionBoundary` draws its in-place failure
 * with a reload button the reader can press once whatever is wrong is fixed. A timestamp rather than a set-once flag so that a SECOND rebuild an hour
 * later in the same tab still gets its silent reload; `sessionStorage` rather than memory because the reload is what wipes memory.
 *
 * `preventDefault()` only on the branch that reloads: it is what stops Vite rethrowing, and a rethrow there would race the navigation into the
 * boundary's fallback for a frame. On the guarded branch the rethrow is exactly what has to happen.
 */

/** How recent a guarded reload must be for a fresh preload failure to count as that reload not having helped. A failure on the reloaded page's own
 *  first paint lands well inside it; a reader's later section switch, after a second rebuild, lands well outside it. */
export const RELOAD_GUARD_MS = 10_000;

/** The sessionStorage key holding the last guarded reload's epoch ms. */
export const RELOAD_GUARD_KEY = 'backlog-manager.preload-reload-at';

export interface PreloadReloadDeps {
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  reload: () => void;
  now?: () => number;
}

/** Installs the listener and returns its uninstall. Dependencies are parameters so the jsdom suite can hand in a counted `reload` — jsdom's own
 *  `location.reload` is not configurable. */
export function installPreloadReload({ target, storage, reload, now = Date.now }: PreloadReloadDeps): () => void {
  const onPreloadError = (event: Event): void => {
    let last = NaN;
    try {
      last = Number(storage.getItem(RELOAD_GUARD_KEY));
    } catch {
      // A storage that throws (privacy mode, a quota) cannot carry the guard, so it cannot be told apart from a loop: let the boundary handle it.
      return;
    }
    const at = now();
    if (Number.isFinite(last) && last > 0 && at - last < RELOAD_GUARD_MS) return;
    try {
      storage.setItem(RELOAD_GUARD_KEY, String(at));
    } catch {
      return;
    }
    event.preventDefault();
    reload();
  };
  target.addEventListener('vite:preloadError', onPreloadError);
  return () => target.removeEventListener('vite:preloadError', onPreloadError);
}

/**
 * The page's own wiring, called by main.tsx before the first render. `window.sessionStorage` is a getter that THROWS (a `SecurityError`) in a browser
 * that blocks site storage for this origin — and main.tsx runs at module top level, outside every boundary, so reading it there would blank the whole
 * app before React draws anything: the very failure this file exists to prevent, caused by the cure (#270 fix loop 1). So the getter is read lazily,
 * per call, inside the `try` blocks `installPreloadReload` already wraps around every storage access — a blocked storage then reads as "cannot carry
 * the guard", which leaves the failure to `SectionBoundary` exactly as a throwing `getItem` does.
 */
export function installPreloadReloadOnWindow(win: Window): () => void {
  return installPreloadReload({
    target: win,
    storage: {
      getItem: (key) => win.sessionStorage.getItem(key),
      setItem: (key, value) => win.sessionStorage.setItem(key, value),
    },
    reload: () => win.location.reload(),
  });
}
