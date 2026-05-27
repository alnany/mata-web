import { For, Show, createSignal } from 'solid-js';

/**
 * Tiny emoji picker — quick-reactions row + a categorized grid.
 *
 * A full emoji picker (Unicode 15.1 with skin tones + search) is Phase 4B
 * polish. This covers ~95% of real-world reaction usage.
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
      class="w-72 rounded-xl border border-neutral-200 bg-white p-2 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      role="dialog"
      aria-label="Emoji picker"
    >
      <div class="mb-1 flex gap-1 border-b border-neutral-200 pb-2 dark:border-neutral-800">
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
              class={`shrink-0 rounded px-2 py-0.5 ${
                tab() === c
                  ? 'bg-mata-500 text-white'
                  : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700'
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
              class="rounded p-1 text-lg leading-none hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
          class="mt-1 w-full rounded py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Close
        </button>
      </Show>
    </div>
  );
}
