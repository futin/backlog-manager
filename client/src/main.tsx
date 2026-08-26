import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The three faces the ported stylesheet asks for through --font, --display and
// --mono. Imported here rather than linked from a CDN so the app works offline
// and over a tailnet with no external hosts.
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';

import './styles.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
