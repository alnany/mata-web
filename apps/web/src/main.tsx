/* @refresh reload */
import './styles/global.css';

import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { App } from './App.js';
import { HomePage } from './routes/home.js';
import { LoginPage } from './routes/login.js';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found in index.html');

// Service worker — precaches hashed assets + provides offline shell.
// Registered after render so it never delays first paint; the worker
// handles its own install lifecycle. Wrapped in feature detection so
// the dev server (no SW shipped) doesn't 404 noisily.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
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
