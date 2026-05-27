import { createEffect, on, Show, type Accessor } from 'solid-js';
import type { RoomMessageEvent } from '@mata/shared/matrix';
import { prettyName } from './message-bubble.js';

/**
 * Composer with reply/edit indicator strip.
 *
 * Layout reserves space whether or not a reply/edit is active so the
 * composer doesn't visibly resize when you click Reply.
 */
export function Composer(props: {
  draft: Accessor<string>;
  setDraft: (v: string) => void;
  replyingTo: RoomMessageEvent | null;
  editing: RoomMessageEvent | null;
  onCancelContext: () => void;
  onSubmit: () => void;
  onTyping: () => void;
  /** Called when the user picks a file from the attach button. */
  onAttach?: (file: File) => void;
  /** Tells parent the textarea wants focus (after picking reply target etc). */
  focusToken: Accessor<number>;
}) {
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;

  // Auto-focus after any context change.
  createEffect(
    on(props.focusToken, () => {
      textareaRef?.focus();
    }),
  );

  const autosize = () => {
    if (!textareaRef) return;
    textareaRef.style.height = 'auto';
    textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, 180)}px`;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      props.onSubmit();
      requestAnimationFrame(() => autosize());
      return;
    }
    if (e.key === 'Escape' && (props.replyingTo || props.editing)) {
      e.preventDefault();
      props.onCancelContext();
    }
  };

  const contextStrip = () => {
    if (props.editing) {
      return {
        label: 'Editing message',
        preview: props.editing.content.msgtype === 'm.text' ? props.editing.content.body : '…',
        tone: 'border-amber-500',
      };
    }
    if (props.replyingTo) {
      return {
        label: `Replying to ${prettyName(props.replyingTo.sender)}`,
        preview:
          props.replyingTo.content.msgtype === 'm.text' ? props.replyingTo.content.body : '…',
        tone: 'border-mata-500',
      };
    }
    return null;
  };

  return (
    <div class="border-t border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
      <Show when={contextStrip()}>
        {(strip) => (
          <div class={`mb-2 flex items-start gap-2 rounded-md border-l-2 bg-white px-3 py-1.5 dark:bg-neutral-950 ${strip().tone}`}>
            <div class="min-w-0 flex-1">
              <div class="text-[11px] font-medium text-neutral-500">{strip().label}</div>
              <div class="truncate text-xs text-neutral-700 dark:text-neutral-300">
                {strip().preview}
              </div>
            </div>
            <button
              type="button"
              onClick={props.onCancelContext}
              class="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              aria-label="Cancel"
              title="Cancel (Esc)"
            >
              ✕
            </button>
          </div>
        )}
      </Show>

      <div class="flex items-end gap-2">
        <Show when={props.onAttach && !props.editing}>
          <input
            ref={fileInputRef}
            type="file"
            class="hidden"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file && props.onAttach) props.onAttach(file);
              // Reset so the same file can be picked again later.
              e.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef?.click()}
            class="h-9 w-9 shrink-0 rounded-full text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="Attach file"
            title="Attach file"
          >
            📎
          </button>
        </Show>
        <textarea
          ref={textareaRef}
          value={props.draft()}
          placeholder={props.editing ? 'Edit your message…' : 'Message'}
          rows={1}
          class="flex-1 resize-none rounded-2xl border border-neutral-300 bg-white px-4 py-2 text-sm leading-5 outline-none focus:border-mata-500 focus:ring-2 focus:ring-mata-500/30 dark:border-neutral-700 dark:bg-neutral-950"
          onInput={(e) => {
            props.setDraft(e.currentTarget.value);
            autosize();
            if (e.currentTarget.value) props.onTyping();
          }}
          onKeyDown={onKey}
        />
        <button
          type="button"
          onClick={() => {
            props.onSubmit();
            requestAnimationFrame(() => autosize());
          }}
          disabled={!props.draft().trim()}
          class="h-9 shrink-0 rounded-full bg-mata-500 px-4 text-sm font-semibold text-white shadow-sm transition-opacity hover:bg-mata-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.editing ? 'Save' : 'Send'}
        </button>
      </div>
    </div>
  );
}
