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
  return 'system';
}

const [themeMode, setThemeMode] = createSignal<ThemeMode>(readPersisted());

function applyTheme(mode: ThemeMode) {
  const isDark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
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
