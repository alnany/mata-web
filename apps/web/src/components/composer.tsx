import { createEffect, createSignal, on, Show, type Accessor } from 'solid-js';
import type { RoomMessageEvent, RoomMember, UserId } from '@mata/shared/matrix';
import { prettyName } from './message-bubble.js';
import { MentionPopover, matchMembers, type MentionMatch } from './mention-popover.js';
import { EmojiPicker } from './emoji-picker.js';

/**
 * Composer with reply/edit indicator strip + @mention autocomplete.
 *
 * Layout reserves space whether or not a reply/edit is active so the
 * composer doesn't visibly resize when you click Reply.
 *
 * Mentions:
 *   The composer manages the `@query` state purely off textarea
 *   selection events. We detect `@` immediately preceding the caret
 *   (or `@<query>` where <query> matches /[A-Za-z0-9_.-]*\/) and open
 *   a popover. Picking inserts `@<displayname> ` at the caret and
 *   pushes the userId into a parent-owned `mentionedUserIds` set so
 *   the eventual send can attach MSC3952 m.mentions.
 *
 *   We do NOT prevent the user from typing `@foo` without picking
 *   from the popover — that just sends as plain text. The popover
 *   is an accelerator, not a gate.
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
  /**
   * Optional: tells the composer the parent has staged attachments
   * pending send. When >0 the Send button enables even with empty
   * text (pure attachment send is legal) and the Enter handler fires
   * onSubmit instead of bailing on empty draft.
   */
  hasStagedAttachments?: Accessor<boolean>;
  /** Tells parent the textarea wants focus (after picking reply target etc). */
  focusToken: Accessor<number>;
  /**
   * Lazy-loader for the active room's member list. We do not eagerly
   * subscribe — autocomplete only needs the list once `@` is typed.
   * Composer caches the resolved promise itself for the lifetime of
   * the active room; parent is responsible for invalidating
   * (re-mount via key or resetToken) when the room changes.
   */
  loadMembers?: () => Promise<RoomMember[]>;
  /**
   * Notifies the parent that a member was picked from the popover.
   * Parent collects these into the next send's m.mentions list.
   */
  onMention?: (userId: UserId) => void;
}) {
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;

  // Emoji popover open state. We anchor it above the smiley button via
  // a position:absolute element inside the composer frame so it
  // automatically follows the composer when it grows.
  const [emojiOpen, setEmojiOpen] = createSignal(false);

  /**
   * Insert `emoji` at the textarea caret, preserving selection and
   * surrounding text. Triggers `setDraft` so the controlled value
   * stays in sync, and refocuses the textarea so the user can keep
   * typing.
   */
  const insertEmoji = (emoji: string) => {
    const el = textareaRef;
    const current = props.draft();
    if (!el) {
      props.setDraft(current + emoji);
      return;
    }
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const next = current.slice(0, start) + emoji + current.slice(end);
    props.setDraft(next);
    // After Solid flushes the new value, restore caret AFTER the emoji.
    queueMicrotask(() => {
      if (!textareaRef) return;
      textareaRef.focus();
      const caret = start + emoji.length;
      textareaRef.setSelectionRange(caret, caret);
      autosize();
    });
  };

  // ---- mention state ------------------------------------------------------
  // `mentionState` is null when no @ is active. When active it carries
  // the textarea offset where the `@` sits (so we can replace `@query`
  // cleanly on pick) plus the current query and resolved candidates.
  const [mentionState, setMentionState] = createSignal<{
    atOffset: number;
    query: string;
    results: MentionMatch[];
    activeIndex: number;
  } | null>(null);

  // Cached member list per Composer mount. The parent guarantees a
  // fresh Composer per room (via Solid key) so this cache is per-room.
  let membersCache: Promise<RoomMember[]> | null = null;
  const fetchMembers = (): Promise<RoomMember[]> => {
    if (!props.loadMembers) return Promise.resolve([]);
    if (!membersCache) membersCache = props.loadMembers();
    return membersCache;
  };

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

  /**
   * Scan the draft up to the caret and figure out whether we're
   * inside a `@…` token. Returns the offset of the `@` and the
   * partial query (text after `@`, before caret). Returns null when
   * not in a mention.
   *
   * Rule for what counts as "in a mention":
   *   - There is an `@` at some position before the caret
   *   - Either it's at position 0, or the character before it is
   *     whitespace / start-of-line — we don't trigger autocomplete
   *     for an `@` inside an email address ("foo@bar.com").
   *   - Between that `@` and the caret, every character matches
   *     /[A-Za-z0-9._-]/ — anything else (incl. space) breaks the
   *     token and dismisses the popover.
   */
  const detectMention = (text: string, caret: number): { atOffset: number; query: string } | null => {
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '@') {
        if (i === 0 || /[\s\n]/.test(text[i - 1] ?? ' ')) {
          return { atOffset: i, query: text.slice(i + 1, caret) };
        }
        return null;
      }
      if (!ch || !/[A-Za-z0-9._-]/.test(ch)) return null;
      i--;
    }
    return null;
  };

  /**
   * Recompute mention state from the textarea's current content +
   * caret. Called from every input/selection change. Issues the
   * member fetch on first activation; subsequent reactivations
   * within the same mount reuse the cached list.
   */
  const refreshMention = async () => {
    if (!textareaRef) return;
    const text = textareaRef.value;
    const caret = textareaRef.selectionStart ?? text.length;
    const probe = detectMention(text, caret);
    if (!probe) {
      setMentionState(null);
      return;
    }
    const members = await fetchMembers();
    const results = matchMembers(members, probe.query);
    // Re-check caret: the user may have typed more characters while
    // the await above was outstanding. We only commit state if the
    // detected mention range still matches the current caret.
    const text2 = textareaRef.value;
    const caret2 = textareaRef.selectionStart ?? text2.length;
    const probe2 = detectMention(text2, caret2);
    if (!probe2 || probe2.atOffset !== probe.atOffset) {
      // The user has moved on. Either close (no longer in a mention)
      // or let the next refreshMention call handle the new state.
      if (!probe2) setMentionState(null);
      return;
    }
    setMentionState((prev) => {
      const nextActive = prev && prev.atOffset === probe2.atOffset
        ? Math.min(prev.activeIndex, Math.max(0, results.length - 1))
        : 0;
      return {
        atOffset: probe2.atOffset,
        query: probe2.query,
        results,
        activeIndex: nextActive,
      };
    });
  };

  const pickMention = (m: RoomMember) => {
    const s = mentionState();
    if (!s || !textareaRef) return;
    const before = textareaRef.value.slice(0, s.atOffset);
    const after = textareaRef.value.slice(textareaRef.selectionStart ?? textareaRef.value.length);
    const display = m.displayname || prettyName(m.userId);
    // Insert as `@displayname ` so the next keystroke types after a
    // space, not glued to the mention.
    const inserted = `@${display} `;
    const next = before + inserted + after;
    props.setDraft(next);
    setMentionState(null);
    props.onMention?.(m.userId);
    // Place caret after the inserted mention.
    queueMicrotask(() => {
      if (!textareaRef) return;
      const pos = before.length + inserted.length;
      textareaRef.focus();
      textareaRef.setSelectionRange(pos, pos);
      autosize();
    });
  };

  const onKey = (e: KeyboardEvent) => {
    // Mention navigation has to fire BEFORE Enter-to-send, otherwise
    // pressing Enter while the popover is open would send instead of
    // picking the highlighted candidate.
    const s = mentionState();
    if (s && s.results.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionState({ ...s, activeIndex: (s.activeIndex + 1) % s.results.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionState({
          ...s,
          activeIndex: (s.activeIndex - 1 + s.results.length) % s.results.length,
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const pick = s.results[s.activeIndex];
        if (pick) {
          e.preventDefault();
          pickMention(pick.member);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionState(null);
        return;
      }
    }
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
    <div
      class="border-t bg-conv px-[22px] pb-[18px] pt-[12px]"
      style={{ 'border-color': 'var(--color-line)' }}
    >
      <Show when={contextStrip()}>
        {(strip) => (
          <div
            class="mb-2 flex items-start gap-2 rounded-[8px] border-l-2 bg-elev px-3 py-1.5"
            style={{ 'border-left-color': 'var(--color-accent)' }}
          >
            <div class="min-w-0 flex-1">
              <div class="mono text-[10.5px] uppercase tracking-[0.04em] text-fg-4">
                {strip().label}
              </div>
              <div class="truncate text-[12.5px] text-fg-2">{strip().preview}</div>
            </div>
            <button
              type="button"
              onClick={props.onCancelContext}
              class="rounded-[6px] p-1 text-fg-3 hover:bg-input hover:text-fg"
              aria-label="Cancel"
              title="Cancel (Esc)"
            >
              ✕
            </button>
          </div>
        )}
      </Show>

      {/* Composer frame — single unified rect, textarea + actions row */}
      <div
        class="rounded-[12px] border bg-input px-[12px] pb-[8px] pt-[10px] transition-colors focus-within:border-[var(--color-line-2)]"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        <div class="relative">
          <MentionPopover
            results={mentionState()?.results ?? []}
            activeIndex={mentionState()?.activeIndex ?? 0}
            onPick={pickMention}
            onHover={(i) => {
              const s = mentionState();
              if (s) setMentionState({ ...s, activeIndex: i });
            }}
          />
          <textarea
            ref={textareaRef}
            value={props.draft()}
            placeholder={props.editing ? 'Edit your message…' : 'Message'}
            rows={1}
            class="block w-full resize-none bg-transparent text-[14px] leading-[1.5] text-fg placeholder:text-fg-3 outline-none"
            style={{ 'min-height': '24px' }}
            onInput={(e) => {
              props.setDraft(e.currentTarget.value);
              autosize();
              if (e.currentTarget.value) props.onTyping();
              void refreshMention();
            }}
            onKeyDown={onKey}
            onClick={() => void refreshMention()}
            onKeyUp={(e) => {
              if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
                void refreshMention();
              }
            }}
            onBlur={() => {
              setTimeout(() => setMentionState(null), 120);
            }}
          />
        </div>

        {/* Actions row */}
        <div class="mt-[6px] flex items-center gap-[2px]">
          <Show when={props.onAttach && !props.editing}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              class="hidden"
              onChange={(e) => {
                // Stage every selected file. Picking a batch of photos
                // at once is the common case; staging only the first
                // (the old behavior) silently dropped the rest.
                const files = e.currentTarget.files;
                if (files && props.onAttach) {
                  for (const file of Array.from(files)) props.onAttach(file);
                }
                e.currentTarget.value = '';
              }}
            />
            <ComposerIconButton
              onClick={() => fileInputRef?.click()}
              label="Attach file"
            >
              <IconPaperclip class="h-[14px] w-[14px]" />
            </ComposerIconButton>
          </Show>

          <div class="relative">
            <ComposerIconButton
              label="Insert emoji"
              onClick={() => setEmojiOpen((v) => !v)}
            >
              <IconSmile class="h-[14px] w-[14px]" />
            </ComposerIconButton>
            <Show when={emojiOpen()}>
              <>
                {/* Click-outside backdrop */}
                <div
                  class="fixed inset-0 z-30"
                  onClick={() => setEmojiOpen(false)}
                />
                {/* Popover anchored above the smiley button. The
                    EmojiPicker brings its own surface; we wrap it in
                    a positioned shell so it doesn't push composer
                    layout. */}
                <div class="absolute bottom-full left-0 z-40 mb-2">
                  <EmojiPicker
                    onPick={(e) => {
                      insertEmoji(e);
                      setEmojiOpen(false);
                    }}
                    onClose={() => setEmojiOpen(false)}
                  />
                </div>
              </>
            </Show>
          </div>

          <div class="flex-1" />

          {/* E2EE status (pulse dot · mono label). Only the dot animates. */}
          <span
            class="mono flex items-center gap-[6px] rounded-[6px] px-[8px] py-[4px] text-[10.5px] text-fg-3"
            title="End-to-end encrypted"
          >
            <span class="dot-accent mata-pulse" />
            <span>e2ee</span>
          </span>

          {/* Send button */}
          <button
            type="button"
            onClick={() => {
              props.onSubmit();
              requestAnimationFrame(() => autosize());
            }}
            disabled={!props.draft().trim() && !props.hasStagedAttachments?.()}
            class="flex h-[30px] shrink-0 items-center gap-[6px] rounded-[7px] bg-accent pl-[14px] pr-[12px] text-[12px] text-accent-ink transition-[filter] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ 'font-weight': 500 }}
          >
            <span>{props.editing ? 'Save' : 'Send'}</span>
            <span
              class="mono rounded-[4px] px-[5px] py-[1px] text-[10px]"
              style={{ background: 'rgba(0,0,0,0.18)' }}
            >
              ⌘↩
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ComposerIconButton(props: { label: string; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="flex h-[28px] w-[28px] items-center justify-center rounded-[6px] text-fg-3 transition-colors hover:bg-elev hover:text-fg"
      aria-label={props.label}
      title={props.label}
    >
      {props.children}
    </button>
  );
}

function IconPaperclip(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function IconSmile(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  );
}
