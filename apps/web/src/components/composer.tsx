import { createEffect, createSignal, on, Show, type Accessor } from 'solid-js';
import type { RoomMessageEvent, RoomMember, UserId } from '@mata/shared/matrix';
import { prettyName } from './message-bubble.js';
import { MentionPopover, matchMembers, type MentionMatch } from './mention-popover.js';

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
        <div class="relative flex-1">
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
            class="w-full resize-none rounded-2xl border border-neutral-300 bg-white px-4 py-2 text-sm leading-5 outline-none focus:border-mata-500 focus:ring-2 focus:ring-mata-500/30 dark:border-neutral-700 dark:bg-neutral-950"
            onInput={(e) => {
              props.setDraft(e.currentTarget.value);
              autosize();
              if (e.currentTarget.value) props.onTyping();
              void refreshMention();
            }}
            onKeyDown={onKey}
            // Selection-change events fire for clicks + arrow keys, so the
            // popover opens/closes correctly when the caret crosses
            // mention boundaries without typing.
            onClick={() => void refreshMention()}
            onKeyUp={(e) => {
              if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
                void refreshMention();
              }
            }}
            onBlur={() => {
              // Defer so a popover-click can fire first.
              setTimeout(() => setMentionState(null), 120);
            }}
          />
        </div>
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
