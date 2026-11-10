import './lib/zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/legacy.css';
import './styles/shell.css';
import {
  applyAppearance,
  readAppearance,
  restoreAppearanceBackup,
} from './lib/appearance';
import { nativePlatform } from './lib/transport';

if (!nativePlatform() && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

// Apply the stored appearance before the first paint, including sign-in, so
// e-ink devices never render (and then refresh away from) the standard theme.
applyAppearance(readAppearance());

// A change made just before the app was killed may survive only in the
// IndexedDB copy; restore it before React reads the stored appearance.
void restoreAppearanceBackup().then((restored) => {
  if (restored) applyAppearance(readAppearance());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
