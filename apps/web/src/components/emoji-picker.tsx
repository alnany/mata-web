import { For, Show, createSignal } from 'solid-js';

/**
 * Tiny emoji picker — quick-reactions row + a categorized grid.
 *
 * A full emoji picker (Unicode 15.1 with skin tones + search) is a
 * later polish lap. This covers ~95% of real-world reaction usage and
 * lives in two surfaces: hover-popover on bubbles (for reactions) and
 * the composer smiley button (for inline insertion).
 *
 * Tokens: surface = bg-elev, lines = border-line. The accent tab is the
 * canonical lime. Hover surfaces lift via line-2.
 */

const QUICK = ['👍', '❤️', '😂', '🎉', '🔥', '😮', '😢', '🙏'];

const CATEGORIES: Record<string, string[]> = {
  Smileys: ['😀', '😁', '😂', '🤣', '😅', '🙂', '😉', '😍', '😘', '🤔', '🙄', '😴', '😎', '🥳', '😭', '😢', '😡'],
  Gestures: ['👍', '👎', '👏', '🙌', '🙏', '👊', '✌️', '🤞', '🤝', '💪', '👀', '👌'],
  Hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💖', '💯'],
  Objects: ['🎉', '🔥', '✨', '⭐', '💡', '📌', '📎', '✅', '❌', '⚠️', '🚀', '🎯'],
  Animals: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮'],
};

export function EmojiPicker(props: { onPick: (emoji: string) => void; onClose?: () => void }) {
  const [tab, setTab] = createSignal<string>('Smileys');
  return (
    <div
      class="w-72 rounded-[10px] border bg-elev p-2 shadow-xl"
      style={{ 'border-color': 'var(--color-line)' }}
      role="dialog"
      aria-label="Emoji picker"
    >
      <div
        class="mb-1 flex gap-1 border-b pb-2"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        <For each={QUICK}>
          {(e) => (
            <button
              type="button"
              class="text-lg leading-none transition-transform hover:scale-125"
              onClick={() => props.onPick(e)}
              aria-label={`React ${e}`}
            >
              {e}
            </button>
          )}
        </For>
      </div>
      <div class="mb-1 flex gap-1 overflow-x-auto pb-1 text-[10px]">
        <For each={Object.keys(CATEGORIES)}>
          {(c) => (
            <button
              type="button"
              class={`shrink-0 rounded-[6px] px-2 py-0.5 transition-colors ${
                tab() === c
                  ? 'bg-accent text-accent-ink'
                  : 'bg-input text-fg-2 hover:text-fg'
              }`}
              onClick={() => setTab(c)}
            >
              {c}
            </button>
          )}
        </For>
      </div>
      <div class="grid max-h-48 grid-cols-7 gap-1 overflow-y-auto p-1">
        <For each={CATEGORIES[tab()]}>
          {(e) => (
            <button
              type="button"
              class="rounded-[6px] p-1 text-lg leading-none hover:bg-input"
              onClick={() => props.onPick(e)}
            >
              {e}
            </button>
          )}
        </For>
      </div>
      <Show when={props.onClose}>
        <button
          type="button"
          onClick={props.onClose}
          class="mt-1 w-full rounded-[6px] py-1 text-[11px] text-fg-3 hover:bg-input hover:text-fg"
        >
          Close
        </button>
      </Show>
    </div>
  );
}
