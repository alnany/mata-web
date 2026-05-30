import { createEffect, createSignal, on, onCleanup, Show, type Accessor } from 'solid-js';
import type { RoomMessageEvent, RoomMember, UserId } from '@mata/shared/matrix';
import { prettyName } from './message-bubble.js';
import { MentionPopover, matchMembers, type MentionMatch } from './mention-popover.js';
import { EmojiPicker } from './emoji-picker.js';
import {
  canRecordVoice,
  computeWaveform,
  flatWaveform,
  formatDuration,
  pickRecordingMime,
} from '../lib/voice.js';

/** Payload handed to the parent when a voice note finishes recording. */
export interface VoiceClip {
  blob: Blob;
  mimetype: string;
  durationMs: number;
  waveform: number[];
}

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
  /**
   * Pressing ↑ on an empty composer jumps straight into editing your
   * most recent message (iMessage / Slack / Telegram muscle memory).
   * Optional — only fires when the draft is empty and no reply/edit
   * context is active.
   */
  onEditLast?: () => void;
  /** Called when the user picks a file from the attach button. */
  onAttach?: (file: File) => void;
  /**
   * Called when a voice note finishes recording. When omitted, the mic
   * button is hidden. The parent owns the upload (it has the room id +
   * worker handle); the composer only captures + measures the clip.
   */
  onSendVoice?: (clip: VoiceClip) => void;
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

  // ── Voice recording ───────────────────────────────────────────────
  // recState drives the composer's swap between the normal input row
  // and the recording bar. 'processing' covers the brief gap between
  // MediaRecorder.stop() and the decoded-waveform handoff.
  const voiceSupported = canRecordVoice();
  const [recState, setRecState] = createSignal<'idle' | 'recording' | 'processing'>('idle');
  const [recMs, setRecMs] = createSignal(0);
  let mediaRecorder: MediaRecorder | undefined;
  let mediaStream: MediaStream | undefined;
  let recChunks: Blob[] = [];
  let recTimer: ReturnType<typeof setInterval> | undefined;
  let recMime = '';
  let recCancelled = false;

  function stopTracks() {
    if (recTimer) {
      clearInterval(recTimer);
      recTimer = undefined;
    }
    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = undefined;
  }

  async function startRecording() {
    if (recState() !== 'idle' || !voiceSupported) return;
    const mime = pickRecordingMime();
    if (!mime) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Permission denied / no device — stay idle, no nag.
      return;
    }
    recChunks = [];
    recCancelled = false;
    recMime = mime;
    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream);
      recMime = mediaRecorder.mimeType || mime;
    }
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recChunks.push(e.data);
    };
    mediaRecorder.onstop = () => void finalizeRecording();
    mediaRecorder.start();
    setRecState('recording');
    const startTs = Date.now();
    setRecMs(0);
    recTimer = setInterval(() => setRecMs(Date.now() - startTs), 100);
  }

  function cancelRecording() {
    recCancelled = true;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    } else {
      stopTracks();
      setRecState('idle');
      setRecMs(0);
    }
  }

  function finishRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      setRecState('processing');
      mediaRecorder.stop();
    }
  }

  async function finalizeRecording() {
    stopTracks();
    const wasCancelled = recCancelled;
    const chunks = recChunks;
    const elapsed = recMs();
    recChunks = [];
    mediaRecorder = undefined;
    if (wasCancelled || chunks.length === 0) {
      setRecState('idle');
      setRecMs(0);
      return;
    }
    const blob = new Blob(chunks, { type: recMime });
    // Drop accidental sub-half-second taps so the mic doesn't spam empty
    // blips into the room.
    if (elapsed < 500 && blob.size < 2048) {
      setRecState('idle');
      setRecMs(0);
      return;
    }
    let durationMs = elapsed;
    let waveform: number[];
    try {
      const wf = await computeWaveform(blob);
      waveform = wf.waveform;
      if (wf.durationMs > 0) durationMs = wf.durationMs;
    } catch {
      waveform = flatWaveform();
    }
    props.onSendVoice?.({ blob, mimetype: recMime, durationMs, waveform });
    setRecState('idle');
    setRecMs(0);
  }

  onCleanup(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      recCancelled = true;
      mediaRecorder.stop();
    }
    stopTracks();
  });

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

  /**
   * Wrap the current textarea selection in `marker` (e.g. `**`, `_`,
   * `` ` ``). With no selection, inserts the marker pair and parks the
   * caret between them so the user can type the emphasized text.
   */
  const wrapSelection = (marker: string) => {
    const el = textareaRef;
    const current = props.draft();
    if (!el) return;
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const sel = current.slice(start, end);
    const next = `${current.slice(0, start)}${marker}${sel}${marker}${current.slice(end)}`;
    props.setDraft(next);
    queueMicrotask(() => {
      if (!textareaRef) return;
      textareaRef.focus();
      const a = start + marker.length;
      const b = a + sel.length;
      textareaRef.setSelectionRange(a, b);
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
    // Markdown formatting shortcuts: wrap the selection in **/_ /`.
    // Mirrors Telegram/Element — the surrounding markers are converted
    // to org.matrix.custom.html on send.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const marker =
        e.key === 'b' || e.key === 'B'
          ? '**'
          : e.key === 'i' || e.key === 'I'
            ? '_'
            : (e.key === 'e' || e.key === 'E') && e.shiftKey
              ? '`'
              : null;
      if (marker) {
        e.preventDefault();
        wrapSelection(marker);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      props.onSubmit();
      requestAnimationFrame(() => autosize());
      return;
    }
    if (
      e.key === 'ArrowUp' &&
      props.onEditLast &&
      !props.editing &&
      !props.replyingTo &&
      props.draft().trim() === ''
    ) {
      e.preventDefault();
      props.onEditLast();
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
        <Show
          when={recState() === 'idle'}
          fallback={
            <RecordingBar
              ms={recMs()}
              processing={recState() === 'processing'}
              onCancel={cancelRecording}
              onSend={finishRecording}
            />
          }
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

          {/* Voice record — Telegram-style mic. Hidden while editing,
              while a draft is in flight (send takes priority), or when
              the runtime can't record. */}
          <Show
            when={
              props.onSendVoice &&
              voiceSupported &&
              !props.editing &&
              !props.draft().trim() &&
              !props.hasStagedAttachments?.()
            }
          >
            <ComposerIconButton label="Record voice message" onClick={() => void startRecording()}>
              <IconMic class="h-[15px] w-[15px]" />
            </ComposerIconButton>
          </Show>

          {/* Send button */}
          <Show
            when={
              !(
                props.onSendVoice &&
                voiceSupported &&
                !props.editing &&
                !props.draft().trim() &&
                !props.hasStagedAttachments?.()
              )
            }
          >
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
          </Show>
        </div>
        </Show>
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

/**
 * In-composer recording bar. Replaces the textarea + actions row while
 * a voice note is being captured: pulsing record dot, live mm:ss timer,
 * a discard (trash) button, and a send button. The send button shows a
 * spinner during the brief decode/measure step.
 */
function RecordingBar(props: {
  ms: number;
  processing: boolean;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <div class="flex items-center gap-3 py-[5px]">
      <button
        type="button"
        onClick={props.onCancel}
        class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] text-fg-3 transition-colors hover:bg-elev hover:text-fg"
        aria-label="Discard recording"
        title="Discard"
      >
        <IconTrash class="h-[15px] w-[15px]" />
      </button>

      <div class="flex flex-1 items-center gap-[10px]">
        <span
          class="h-[9px] w-[9px] shrink-0 rounded-full"
          style={{ background: '#ff4d4f' }}
          classList={{ 'animate-pulse': !props.processing }}
        />
        <span class="text-[13px] text-fg-2">
          {props.processing ? 'Processing…' : 'Recording'}
        </span>
        <span class="mono text-[12.5px] tabular-nums text-fg-3">{formatDuration(props.ms)}</span>
      </div>

      <button
        type="button"
        onClick={props.onSend}
        disabled={props.processing}
        class="flex h-[30px] shrink-0 items-center gap-[6px] rounded-[7px] bg-accent pl-[13px] pr-[13px] text-[12px] text-accent-ink transition-[filter] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        style={{ 'font-weight': 500 }}
        aria-label="Send voice message"
      >
        <IconSend class="h-[14px] w-[14px]" />
        <span>Send</span>
      </button>
    </div>
  );
}

function IconMic(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}
function IconTrash(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
function IconSend(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
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
