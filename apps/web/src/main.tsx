import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/legacy.css';
import './styles/shell.css';
import { nativePlatform } from './lib/transport';

if (!nativePlatform() && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

// Apply the stored appearance before the first paint, including sign-in, so
// e-ink devices never render (and then refresh away from) the standard theme.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem('hub:eink') === 'true' ? 'eink' : 'standard';
} catch {
  /* Storage unavailable: standard theme. */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
