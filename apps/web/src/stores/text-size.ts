/**
 * Text-size store — three steps for message body type.
 *
 * Why a store and not just Tailwind classes: text size has to be
 * applied at the document level (one knob, every bubble follows) and
 * survive reloads. Tailwind doesn't ship a "user-chosen size" knob,
 * so we drive it via CSS custom properties on `<html>` and a tiny
 * `.mata-msg-text` utility (see global.css). The message bubble body
 * is the only thing it scales — UI chrome (labels, menus, drawer
 * text) stays fixed so the layout doesn't drift between sizes.
 *
 * Persistence is plain localStorage. SSR isn't a concern (this is a
 * Vite SPA), but `try/catch` defends against private-mode quotas.
 */

import { createSignal, createEffect } from 'solid-js';

export type TextSize = 'sm' | 'md' | 'lg';

const KEY = 'mata.textSize';
const DEFAULT: TextSize = 'md';

function readPersisted(): TextSize {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'sm' || v === 'md' || v === 'lg') return v;
  } catch {
    // ignore
  }
  return DEFAULT;
}

const [textSize, setTextSize] = createSignal<TextSize>(readPersisted());

function applyTextSize(size: TextSize): void {
  const html = document.documentElement;
  html.classList.remove('text-size-sm', 'text-size-md', 'text-size-lg');
  html.classList.add(`text-size-${size}`);
}

// Apply once on module load so first paint already has the right
// variable (theme bootstrap does the same trick for `.dark`).
applyTextSize(textSize());

createEffect(() => {
  const s = textSize();
  applyTextSize(s);
  try {
    localStorage.setItem(KEY, s);
  } catch {
    // ignore
  }
});

export { textSize, setTextSize };

export const TEXT_SIZE_LABEL: Record<TextSize, string> = {
  sm: 'Small',
  md: 'Default',
  lg: 'Large',
};
