/**
 * Theme store — light / dark / system. Persists to localStorage.
 * Toggles `.dark` on <html>.
 */

import { createSignal, createEffect } from 'solid-js';

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'mata.theme';

function readPersisted(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // ignore
  }
  // Design spec (HANDOFF.md §"Themes"): default theme is dark. The HTML
  // bootstrap script already paints `.dark` before this module loads, so
  // returning 'dark' here keeps subsequent reactive applies idempotent.
  return 'dark';
}

const [themeMode, setThemeMode] = createSignal<ThemeMode>(readPersisted());

function applyTheme(mode: ThemeMode) {
  const isDark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const html = document.documentElement;
  html.classList.toggle('dark', isDark);
  // The design tokens (global.css) key off `html.light` for the override
  // selector; keep the two classes mutually exclusive so the explicit
  // light theme never sits underneath a stale `dark` class from the
  // bootstrap script.
  html.classList.toggle('light', !isDark);
}

createEffect(() => {
  const m = themeMode();
  applyTheme(m);
  try {
    localStorage.setItem(KEY, m);
  } catch {
    // ignore
  }
});

// React to system preference changes when in system mode.
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (themeMode() === 'system') applyTheme('system');
  });
}

export { themeMode, setThemeMode };
