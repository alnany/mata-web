/* @refresh reload */
import './styles/global.css';

import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { createSignal } from 'solid-js';
import { App } from './App.js';
import { HomePage } from './routes/home.js';
import { LoginPage } from './routes/login.js';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found in index.html');

// Version update signal: fires when a new service worker is waiting to activate.
// Used by HomePage to show an "Update available" banner.
export const [updateAvailable, setUpdateAvailable] = createSignal(false);

// Service worker — precaches hashed assets + provides offline shell.
// Registered after render so it never delays first paint; the worker
// handles its own install lifecycle. Wrapped in feature detection so
// the dev server (no SW shipped) doesn't 404 noisily.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // If a worker is already waiting (e.g., user has visited before,
        // then refreshed the page after we deployed a new version), signal
        // the app to show the update banner immediately.
        if (registration.waiting) {
          setUpdateAvailable(true);
        }

        // Listen for future SW installations (e.g., user leaves tab open
        // while we deploy). On new registration.waiting, show the banner.
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // A new SW has finished installing and there's an active
              // controller, meaning a new version is ready to activate
              // but waiting for clients to close. Signal the update banner.
              setUpdateAvailable(true);
            }
          });
        });

        // CRITICAL: the browser only auto-checks /sw.js for changes on
        // navigation (and roughly once a day). A long-lived SPA tab would
        // otherwise never notice a deploy until the user manually reloads —
        // which defeats the whole point of the banner. So we proactively
        // poll registration.update(): on a 30s interval, and whenever the
        // tab regains focus / visibility / connectivity (covers the common
        // "came back to the tab" case instantly). update() re-fetches the
        // worker; if its bytes changed, the browser fires `updatefound`
        // above and the banner appears with no reload.
        const checkForUpdate = () => {
          registration.update().catch(() => {
            /* offline / transient — next poll retries */
          });
        };
        const POLL_MS = 30_000;
        let timer = window.setInterval(checkForUpdate, POLL_MS);
        const onVisible = () => {
          if (document.visibilityState === 'visible') {
            // Re-arm the interval so a backgrounded tab (where timers are
            // throttled) checks immediately on return, then resumes polling.
            window.clearInterval(timer);
            checkForUpdate();
            timer = window.setInterval(checkForUpdate, POLL_MS);
          }
        };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', checkForUpdate);
        window.addEventListener('online', checkForUpdate);
      })
      .catch(() => {
        /* SW registration failures are non-fatal — the app still works,
           we just lose the cache fast-path until next visit. */
      });
  });
}

render(
  () => (
    <Router root={App}>
      <Route path="/" component={HomePage} />
      <Route path="/login" component={LoginPage} />
    </Router>
  ),
  root,
);
