/*
  DESIGN.md §8.0 (Shell and rail — the well every section renders into). The failure is drawn where the section would have been, in `.board-empty`, the
  same quiet 11 px `--ink3` line `SectionLoading` draws while the chunk is fetched, so a load that fails reads as the loading line turning into its
  outcome rather than as a new kind of surface. The one control is `.set-link` (§8.6), the bordered `--strip` button Settings already draws for an
  action rather than a preference — reused rather than a new button style for a surface this rare.
*/
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Injected by the jsdom suite; jsdom's `location.reload` is not configurable. */
  onReload?: () => void;
}

interface State {
  failed: boolean;
}

/**
 * The error boundary around the lazy sections (#270). Before it there was none anywhere in client/src, so any throw inside a section — most often a
 * `lazy()` chunk that a rebuild deleted while the tab was open — unmounted the whole tree, rail included, to a blank page. The common case is cured
 * before it gets here, by `installPreloadReload` (lib/preload-reload.ts) reloading the page once; what reaches this boundary is the case a reload did
 * not cure, or a render throw inside a section. Either way the rail stays up, so the reader can still switch sections, and the well says what happened.
 *
 * App keys it by section, so switching to another section clears the failure instead of carrying one section's fallback onto the next.
 */
export class SectionBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const reload = this.props.onReload ?? (() => window.location.reload());
    return (
      <div className="board-empty" role="alert">
        this section failed to load
        <button type="button" className="set-link" onClick={reload}>
          reload
        </button>
      </div>
    );
  }
}
