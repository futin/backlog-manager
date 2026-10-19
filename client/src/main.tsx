import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The one face the whole board is set in — a geometric grotesque, per
// .claude/DESIGN.md §1 and §8.1. Self-hosted rather than linked from Google
// Fonts the way the reference design's own foundation does: the served build's
// CSP is `default-src 'self'` with no `font-src` (server/src/security.ts, pinned
// by test/csp.test.ts), and the tailnet/phone use case this board is built for
// wants the board to render with no third-party fetch at all.
//
// Four weights, and only four: §1's "Weights in use" table allows nothing
// lighter than 400 and nothing heavier than 700, so importing more would ship
// bytes no rule in styles.css is allowed to ask for.
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';

// ui-kit's one stylesheet (the version chip and the What's new drawer), imported here and never from a component, so a Jest suite over its CommonJS build
// never meets a `.css` import. Before ours, because `styles.css` themes it through `--uk-*` and places the chip with `.rail-release`, which wins on order.
import 'ui-kit/styles.css';
import './styles.css';
import { App } from './App';
import { installPreloadReloadOnWindow } from './lib/preload-reload';

// Before the first render, so a section chunk deleted by a rebuild while this tab was open reloads the page once instead of blanking it (#270).
// Storage is read lazily inside it: a browser blocking site storage throws from the storage getter itself, and up here that would be a blank page.
installPreloadReloadOnWindow(window);

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
