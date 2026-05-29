import { createEffect, createResource, createSignal, For, onCleanup, Show, type Resource } from 'solid-js';
import type {
  EventId,
  MediaMessageBody,
  ReactionAggregate,
  RoomMessageEvent,
  TimelineEvent,
  UserId,
} from '@mata/shared/matrix';
import { shortTime } from '../lib/date-buckets.js';
import { useBridge } from '../bridge/context.js';
import { LinkPreviewCard, extractFirstUrl } from './link-preview.js';
import { EmojiPicker } from './emoji-picker.js';

/**
 * One message bubble. Handles:
 * - Reply preview strip (clickable → scrolls to original)
 * - Edited tag
 * - Reaction pills with toggle
 * - Hover-revealed actions menu (reply, react, copy, copy permalink, edit, delete)
 * - Grouping: when `showHeader` is false (consecutive same-sender), name + avatar collapse
 */

export type MessageActions = {
  onReply: (ev: RoomMessageEvent) => void;
  onReact: (eventId: EventId, key: string) => void;
  onEdit: (ev: RoomMessageEvent) => void;
  onDelete: (eventId: EventId) => void;
  onJumpTo: (eventId: EventId) => void;
  /**
   * Open the thread side-panel rooted at this message. If the
   * message is already in a thread, this opens the existing thread
   * at its root, not a sub-thread (Matrix doesn't support nested
   * threads per MSC3440).
   */
  onOpenThread: (rootEventId: EventId) => void;
  /**
   * Open the forward-target picker. The room-view owns the modal
   * and the room list; the bubble just hands off the source event.
   */
  onForward: (ev: RoomMessageEvent) => void;
};

export function MessageBubble(props: {
  ev: TimelineEvent;
  me: UserId | null;
  showHeader: boolean;
  inReplyToEvent?: TimelineEvent;
  /**
   * Set when this message is the root of an active thread. The
   * bubble renders a clickable "💬 N replies · last reply Xm ago"
   * pill below the message so users can discover and re-enter
   * threads without digging into the More menu. Computed by the
   * parent room view as a single pass over the event cache.
   */
  threadSummary?: {
    count: number;
    lastTs: number;
    lastSender: UserId | null;
  };
  actions: MessageActions;
}) {
  const isMine = () => props.ev.sender === props.me;
  const [showMenu, setShowMenu] = createSignal(false);
  const [showEmoji, setShowEmoji] = createSignal(false);
  // We pin the bubble container so click-outside / Escape can dismiss
  // the popovers without piggybacking on `onMouseLeave` (which used
  // to close the menu the instant the cursor crossed a 1-px gap on
  // the way to clicking an item — terrible UX).
  let bubbleRef: HTMLDivElement | undefined;
  createEffect(() => {
    if (!showMenu() && !showEmoji()) return;
    const onDown = (e: MouseEvent) => {
      if (bubbleRef && !bubbleRef.contains(e.target as Node)) {
        setShowMenu(false);
        setShowEmoji(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowMenu(false);
        setShowEmoji(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    });
  });

  // Most rendering only makes sense for m.room.message — others get a
  // muted system row.
  if (props.ev.type !== 'm.room.message') {
    return <SystemRow ev={props.ev} />;
  }
  const msg = props.ev;
  const edited = msg.edits.length > 0;

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(msg.content.msgtype === 'm.text' ? msg.content.body : '');
    } catch {
      // ignore
    }
    setShowMenu(false);
  };

  const copyPermalink = async () => {
    const url = `https://matrix.to/#/${msg.roomId}/${msg.eventId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // ignore
    }
    setShowMenu(false);
  };

  return (
    <li
      // `msg-enter` (120 ms fade) is intentionally OWN-MESSAGE-OFF.
      // Own messages first appear as a PendingRow at the bottom of
      // the timeline the instant the user hits send — same rectangle,
      // same ink, same timestamp slot as this MessageBubble. When the
      // server echo lands, the pending vanishes and this bubble mounts
      // at a slightly different DOM position (above the pending list).
      // Re-fading the bubble at mount = "flash on the message I just
      // sent." Incoming bubbles still animate because they really are
      // new content from the user's POV.
      class={`${isMine() ? '' : 'msg-enter'} group flex ${isMine() ? 'justify-end' : 'justify-start'} ${
        props.showHeader ? 'mt-3' : 'mt-0.5'
      }`}
      data-event-id={msg.eventId}
    >
      {/* Left gutter avatar for non-mine */}
      <Show when={!isMine()}>
        <div class="mr-2 w-8 shrink-0">
          <Show when={props.showHeader}>
            <div
              class="flex h-8 w-8 items-center justify-center rounded-full bg-input text-xs font-semibold text-fg-2"
              title={msg.sender}
            >
              {initials(msg.sender)}
            </div>
          </Show>
        </div>
      </Show>

      <div ref={bubbleRef} class="relative max-w-[78%]">
        <Show when={props.showHeader && !isMine()}>
          <div class="mb-0.5 text-[11px] font-semibold text-fg-2">
            {prettyName(msg.sender)}
          </div>
        </Show>

        <div
          class={`mata-msg-text relative rounded-2xl px-3 py-2 ${
            isMine()
              ? 'bg-accent text-accent-ink'
              : 'bg-elev text-fg'
          }`}
        >
          {/* Reply preview strip */}
          <Show when={msg.inReplyTo && props.inReplyToEvent}>
            <button
              type="button"
              onClick={() => props.actions.onJumpTo(msg.inReplyTo as EventId)}
              class={`-mx-1 mb-1.5 block w-[calc(100%+0.5rem)] truncate rounded-md border-l-2 px-2 py-1 text-left text-[11px] leading-4 transition-opacity hover:opacity-100 ${
                isMine()
                  ? 'border-accent-ink/40 bg-accent-ink/10 opacity-90'
                  : 'border-accent bg-[var(--color-line)] opacity-80'
              }`}
              title="Jump to original message"
            >
              <span class="block font-medium">
                {prettyName((props.inReplyToEvent as RoomMessageEvent).sender)}
              </span>
              <span class="block truncate">{previewOf(props.inReplyToEvent as TimelineEvent)}</span>
            </button>
          </Show>

          <span class="whitespace-pre-wrap break-words">
            <Body msg={msg} me={props.me} />
          </span>

          {/*
           * Link preview card. Only rendered for text-class
           * messages (m.text / m.notice / m.emote) that carry an
           * http(s) URL the homeserver might know about. Media
           * messages (m.image / m.file / etc.) already have their
           * own visual surface, so a preview underneath would be
           * redundant noise.
           */}
          {(() => {
            const c = msg.content;
            if (c.msgtype !== 'm.text' && c.msgtype !== 'm.notice' && c.msgtype !== 'm.emote') {
              return null;
            }
            const url = extractFirstUrl(c.body);
            if (!url) return null;
            return <LinkPreviewCard url={url} isMine={isMine()} />;
          })()}

          <div
            class={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
              isMine() ? 'text-accent-ink/70' : 'text-fg-3'
            }`}
          >
            <Show when={edited}>
              <span
                title={`Edited (${msg.edits.length}× revisions)`}
                class={`rounded-full border px-1.5 py-px text-[9.5px] font-medium uppercase tracking-[0.04em] ${
                  isMine() ? 'border-accent-ink/30 text-accent-ink/80' : 'border-line text-fg-3'
                }`}
              >
                edited
              </span>
            </Show>
            <span>{shortTime(msg.originServerTs)}</span>
          </div>

          {/*
           * Hover toolbar.
           *
           * Positioning rule: the toolbar's vertical center sits on
           * the bubble's TOP edge (`top-0 -translate-y-1/2`). Half of
           * the toolbar overlaps the bubble itself, the other half
           * pokes above. That overlap is the trick — when the cursor
           * moves from inside the bubble up toward the toolbar, it
           * never crosses an unhovered region, so `group-hover`
           * stays active and the toolbar doesn't flicker out from
           * under the user.
           *
           * Horizontal anchor: floats toward the bubble's "outside"
           * shoulder (left edge for own messages, right edge for
           * others) so it never covers the timestamp / reply preview.
           * Uses `opacity` + `pointer-events` rather than `hidden` —
           * `hidden` causes the menu/emoji popovers to re-mount when
           * the user moves the cursor away momentarily, losing their
           * place. `focus-within` keeps the bar visible for keyboard
           * users tabbing through actions.
           */}
          <div
            class={`absolute top-0 z-20 -translate-y-1/2 transition-opacity duration-100 ${
              showMenu() || showEmoji()
                ? 'pointer-events-auto opacity-100'
                : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
            } ${isMine() ? 'left-2' : 'right-2'}`}
          >
            <div
              class="flex items-center gap-0.5 rounded-full border bg-elev px-1 py-0.5 shadow-md"
              style={{ 'border-color': 'var(--color-line)' }}
            >
              <ActionBtn
                title="React"
                onClick={() => {
                  setShowEmoji((v) => !v);
                  setShowMenu(false);
                }}
              >
                <span class="text-base leading-none">😊</span>
              </ActionBtn>
              <ActionBtn title="Reply" onClick={() => props.actions.onReply(msg)}>
                <span class="text-base leading-none">↩</span>
              </ActionBtn>
              <ActionBtn
                title={msg.threadRoot ? 'Open thread' : 'Reply in thread'}
                onClick={() => {
                  // For replies already inside a thread, jump to the
                  // thread's actual root (Matrix forbids nested threads
                  // per MSC3440).
                  const rootId = msg.threadRoot ?? msg.eventId;
                  props.actions.onOpenThread(rootId);
                }}
              >
                <span class="text-base leading-none">💬</span>
              </ActionBtn>
              <ActionBtn
                title="More"
                onClick={() => {
                  setShowMenu((v) => !v);
                  setShowEmoji(false);
                }}
              >
                <span class="text-base leading-none">⋯</span>
              </ActionBtn>
            </div>

            {/*
             * Overflow menu — nested inside the toolbar wrapper so
             * its `top-full` anchors directly to the toolbar pill's
             * bottom edge (one continuous menu, no air gap between
             * pill and dropdown). Right-aligned to the pill since
             * the ⋯ button is always the rightmost item regardless
             * of which shoulder the toolbar sits on.
             */}
            <Show when={showMenu()}>
              <div
                role="menu"
                class="absolute right-0 top-full z-30 mt-1 min-w-[176px] rounded-lg border bg-elev py-1 text-sm shadow-lg"
                style={{ 'border-color': 'var(--color-line)' }}
              >
                <MenuItem
                  onClick={() => {
                    props.actions.onReply(msg);
                    setShowMenu(false);
                  }}
                >
                  Reply
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    props.actions.onForward(msg);
                    setShowMenu(false);
                  }}
                >
                  Forward
                </MenuItem>
                <MenuDivider />
                <MenuItem onClick={copyText}>Copy text</MenuItem>
                <MenuItem onClick={copyPermalink}>Copy link</MenuItem>
                <Show when={isMine() && msg.content.msgtype === 'm.text'}>
                  <MenuDivider />
                  <MenuItem
                    onClick={() => {
                      props.actions.onEdit(msg);
                      setShowMenu(false);
                    }}
                  >
                    Edit
                  </MenuItem>
                  <MenuItem
                    destructive
                    onClick={() => {
                      props.actions.onDelete(msg.eventId);
                      setShowMenu(false);
                    }}
                  >
                    Delete
                  </MenuItem>
                </Show>
              </div>
            </Show>
          </div>

          {/*
           * Quick emoji popover — anchored ABOVE the bubble, on the
           * same shoulder as the toolbar so the picker visually
           * "grows out of" the React button rather than appearing in
           * a random corner of the bubble.
           */}
          <Show when={showEmoji()}>
            <div
              class={`absolute bottom-full z-30 mb-2 ${
                isMine() ? 'left-0' : 'right-0'
              }`}
            >
              <EmojiPicker
                onPick={(e) => {
                  props.actions.onReact(msg.eventId, e);
                  setShowEmoji(false);
                }}
                onClose={() => setShowEmoji(false)}
              />
            </div>
          </Show>

        </div>

        {/*
         * Thread summary pill — only renders on the thread ROOT
         * message (never on replies, otherwise we'd plaster the
         * indicator on every reply too). Element / Slack pattern:
         * the indicator IS the entry point, so the user can
         * re-enter a thread without remembering it lives behind a
         * hover menu. Click → opens the thread side-panel.
         */}
        <Show when={props.threadSummary && props.threadSummary.count > 0 && !msg.threadRoot}>
          {(_) => {
            const s = props.threadSummary!;
            return (
              <div class={`mt-1 flex ${isMine() ? 'justify-end' : 'justify-start'}`}>
                <button
                  type="button"
                  onClick={() => props.actions.onOpenThread(msg.eventId)}
                  class="group/thread inline-flex max-w-full items-center gap-1.5 rounded-full border bg-elev px-2.5 py-1 text-xs text-fg-2 shadow-sm transition-colors hover:border-mata-500 hover:text-mata-500"
                  style={{ 'border-color': 'var(--color-line)' }}
                  title={`${s.count} ${s.count === 1 ? 'reply' : 'replies'} · last reply ${relativeTime(s.lastTs)}`}
                >
                  <span class="text-sm leading-none">💬</span>
                  <span class="font-medium">
                    {s.count} {s.count === 1 ? 'reply' : 'replies'}
                  </span>
                  <span class="text-fg-3">·</span>
                  <span class="truncate text-fg-3">{relativeTime(s.lastTs)}</span>
                  <span
                    class="text-fg-3 transition-transform group-hover/thread:translate-x-0.5"
                    aria-hidden="true"
                  >
                    →
                  </span>
                </button>
              </div>
            );
          }}
        </Show>

        {/* Reactions pill row */}
        <Show when={msg.reactions.length > 0}>
          <div class={`mt-1 flex flex-wrap gap-1 ${isMine() ? 'justify-end' : 'justify-start'}`}>
            <For each={msg.reactions}>
              {(r) => (
                <ReactionPill r={r} me={props.me} onToggle={() => props.actions.onReact(msg.eventId, r.key)} />
              )}
            </For>
          </div>
        </Show>
      </div>
    </li>
  );
}

/**
 * Short human-friendly relative timestamp, e.g. "just now",
 * "3m ago", "2h ago", "Apr 12". Used for the thread summary pill so
 * users can tell at a glance whether a thread is fresh or stale.
 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ActionBtn(props: { title: string; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      class="flex h-7 w-7 items-center justify-center rounded-full text-base text-fg-2 hover:bg-input"
    >
      {props.children}
    </button>
  );
}

function MenuDivider() {
  return <div class="my-1 h-px" style={{ background: 'var(--color-line)' }} role="separator" />;
}

function MenuItem(props: { onClick: () => void; destructive?: boolean; children: any }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      class={`block w-full px-3 py-1.5 text-left text-sm transition-colors ${
        props.destructive
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
          : 'text-fg hover:bg-input'
      }`}
    >
      {props.children}
    </button>
  );
}

function ReactionPill(props: { r: ReactionAggregate; me: UserId | null; onToggle: () => void }) {
  void props.me; // reserved for hover tooltip when user list lands
  return (
    <button
      type="button"
      onClick={props.onToggle}
      class={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
        props.r.selfReacted
          ? 'border-mata-500 bg-mata-500/15 text-mata-700 dark:text-mata-300'
          : 'border-line-2 bg-elev text-fg-2 hover:bg-input'
      }`}
      title={`${props.r.count} reaction${props.r.count === 1 ? '' : 's'}`}
    >
      <span>{props.r.key}</span>
      <span class="text-[11px]">{props.r.count}</span>
    </button>
  );
}

function Body(props: { msg: RoomMessageEvent; me: UserId | null }) {
  const c = props.msg.content;
  if (c.msgtype === 'm.text' || c.msgtype === 'm.notice' || c.msgtype === 'm.emote') {
    return <TextWithMentions text={c.body} mentions={c.mentions ?? null} me={props.me} />;
  }
  if (c.msgtype === 'm.image' || c.msgtype === 'm.video' || c.msgtype === 'm.audio' || c.msgtype === 'm.file') {
    return <MediaContent body={c} />;
  }
  return `[${c.msgtype}] ${c.body}`;
}

/**
 * Render plain text with `@mention` segments highlighted.
 *
 * We tokenize by the conservative pattern that matches what the
 * composer inserts: `@<word>` where <word> is one or more characters
 * in [A-Za-z0-9._-]. This intentionally does NOT try to resolve the
 * token back to a userId — the canonical source of truth for "is this
 * a real mention" is the event's `m.mentions.user_ids` list (per
 * MSC3952). When that list is present and non-empty, ALL `@word`
 * tokens in the body are rendered as pills; otherwise we fall back to
 * a heuristic "looks like a mention" highlight that just colors the
 * token without making any trust claim.
 *
 * Self-mention check: a body is treated as a self-mention if the
 * mentions list explicitly includes `me`, OR (heuristically) if any
 * `@<word>` matches the localpart of the current user id. Self-mention
 * triggers a stronger pill style on EVERY mention pill in the message
 * — same convention Element follows.
 */
function TextWithMentions(props: {
  text: string;
  mentions: { userIds: UserId[]; room?: boolean } | null;
  me: UserId | null;
}) {
  const segments = () => splitMentions(props.text);
  const meLocal = (): string | null => {
    if (!props.me) return null;
    const local = props.me.slice(1).split(':')[0];
    return local ? local.toLowerCase() : null;
  };
  const isSelfMentioned = () => {
    if (props.me && props.mentions?.userIds.includes(props.me)) return true;
    if (props.mentions?.room) return true;
    const ml = meLocal();
    if (!ml) return false;
    for (const seg of segments()) {
      if (seg.kind !== 'mention') continue;
      if (seg.handle.toLowerCase() === ml) return true;
    }
    return false;
  };
  const treatAsRealMention = !!props.mentions && props.mentions.userIds.length > 0;
  const self = isSelfMentioned();
  return (
    <>
      {segments().map((seg) => {
        if (seg.kind === 'text') return seg.text;
        // Tone gradient:
        //   real-mention + self => bold mata pill
        //   real-mention        => mata pill
        //   heuristic           => subtle neutral pill
        const tone = treatAsRealMention
          ? self
            ? 'bg-mata-100 font-semibold text-mata-800 dark:bg-mata-900/60 dark:text-mata-200'
            : 'bg-mata-50 text-mata-700 dark:bg-mata-950/40 dark:text-mata-300'
          : 'bg-input text-fg-2';
        return (
          <span class={`rounded px-1 ${tone}`} title={`@${seg.handle}`}>
            @{seg.handle}
          </span>
        );
      })}
    </>
  );
}

type MentionSeg = { kind: 'text'; text: string } | { kind: 'mention'; handle: string };

/**
 * Split a string by `@<word>` mention tokens. We never split inside an
 * email-style `@` (preceded by alphanumeric) — that's how we keep
 * "foo@bar.com" rendering as plain text.
 */
function splitMentions(text: string): MentionSeg[] {
  const re = /(^|[\s,.;:!?\n])@([A-Za-z0-9._-]+)/g;
  const out: MentionSeg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) {
    const lead = m[1] ?? '';
    const handle = m[2] ?? '';
    const tokenStart = m.index + lead.length;
    if (tokenStart > last) out.push({ kind: 'text', text: text.slice(last, tokenStart) });
    out.push({ kind: 'mention', handle });
    last = tokenStart + 1 + handle.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * One-sentence friendly copy per decryption-failure category. Keep
 * these short and non-technical — no enum names, no "DecryptionError",
 * no stack traces. The detailed recovery path lives in Settings →
 * Encryption, not in the timeline.
 */
export function encryptedReasonCopy(reason: string | null): string {
  switch (reason) {
    case 'historical':
      return 'Encrypted — sent before you signed in to this device';
    case 'key_withheld':
      return "Encrypted — sender's device wouldn't share the key";
    case 'session_missing':
      return 'Encrypted — key for this conversation is missing on this device';
    case 'verification':
      return "Encrypted — sender's device isn't verified";
    default:
      return 'Encrypted message';
  }
}

function SystemRow(props: { ev: TimelineEvent }) {
  const text = () => {
    const ev = props.ev;
    if (ev.type === 'm.room.encrypted') {
      const prefix = ev.decryptionStatus === 'pending' ? '🔒 Decrypting…' : '🔒';
      if (ev.decryptionStatus === 'pending') return prefix;
      return `${prefix} ${encryptedReasonCopy(ev.failureReason)}`;
    }
    if (ev.type === 'm.room.member') return 'membership change';
    if (ev.type === 'm.room.redaction') return 'message removed';
    return 'system event';
  };
  return (
    <li class="my-1 flex justify-center">
      <span class="rounded-full bg-input px-3 py-1 text-[11px] italic text-fg-3">
        {text()}
      </span>
    </li>
  );
}

/**
 * Deterministic 2-stop gradient for an arbitrary id. Picks one of seven
 * named gradients per the design spec (HANDOFF.md §"Avatar gradients").
 *
 * The `lime` family is reserved for the current user, so callers passing
 * the current user's id should NOT route through this — they should
 * apply the lime gradient directly. We exclude lime from the hash slot
 * pool to make accidental collisions impossible.
 */
export function gradientForUser(userId: string | undefined): { background: string; color: string } {
  const palette = [
    { background: 'linear-gradient(135deg, #c97f4f, #6b3f25)', color: '#fdf3e8' }, // warm
    { background: 'linear-gradient(135deg, #5fa0c4, #2e5972)', color: '#eaf3fb' }, // cool
    { background: 'linear-gradient(135deg, #9b87f5, #5a4aa0)', color: '#f1ecff' }, // violet
    { background: 'linear-gradient(135deg, #c47ec9, #6a3f6e)', color: '#f8eaf9' }, // mauve
    { background: 'linear-gradient(135deg, #7a8f5f, #3e4a32)', color: '#eaf3d8' }, // moss
    { background: 'linear-gradient(135deg, #c08a72, #5e3b29)', color: '#fbecd9' }, // clay
  ];
  let h = 0;
  const s = userId ?? '';
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(h) % palette.length];
}

export function initials(userId: string | undefined): string {
  if (!userId) return '?';
  const localpart = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  return (localpart ?? userId).slice(0, 2).toUpperCase();
}

export function prettyName(userId: string | undefined): string {
  if (!userId) return 'Unknown';
  const localpart = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  return localpart ?? userId;
}

function previewOf(ev: TimelineEvent): string {
  if (ev.type === 'm.room.message') {
    const c = ev.content;
    if ('body' in c) return c.body;
  }
  if (ev.type === 'm.room.encrypted') return '🔒 encrypted';
  return '…';
}

// ---------------------------------------------------------------------------
// MediaContent — image / video / audio / file body.
//
// loadMedia (worker RPC) returns raw bytes; we wrap them in a Blob and
// hand the object URL to <img>/<video>/<audio>. URL.revokeObjectURL is
// best-effort — Solid's createResource doesn't expose an onCleanup
// without a dedicated owner, and the leak is bounded by the
// component's lifetime, so we rely on the GC + page nav to reclaim.
// Encrypted vs plain is fully transparent here: worker auto-detects via
// the presence of `file` on the body.
// ---------------------------------------------------------------------------

function MediaContent(props: { body: MediaMessageBody }) {
  const bridge = useBridge();

  type Loaded = { url: string; mime: string };
  type LoadResult = { loaded: Loaded | null; error: string | null };
  const [resource] = createResource<LoadResult, MediaMessageBody>(
    () => props.body,
    async (body): Promise<LoadResult> => {
      // Resolve the canonical mxc — for encrypted media we use file.url,
      // for plain media we use url. If neither is present (malformed
      // event) we render the filename fallback.
      const mxc = body.file?.url ?? body.url;
      if (!mxc) return { loaded: null, error: 'no mxc URI on event' };
      try {
        // body.file lives inside a Solid store — passing it directly into
        // worker.postMessage trips DataCloneError ("#<Object> could not
        // be cloned") because the proxy isn't structured-cloneable. Snap
        // a plain copy here so the request envelope is pure JSON.
        const ef = body.file
          ? {
              v: 'v2' as const,
              url: body.file.url,
              key: {
                kty: 'oct' as const,
                alg: 'A256CTR' as const,
                key_ops: ['encrypt', 'decrypt'] as ['encrypt', 'decrypt'],
                k: body.file.key.k,
                ext: true as const,
              },
              iv: body.file.iv,
              hashes: { sha256: body.file.hashes.sha256 },
            }
          : null;
        const res = await bridge.request({
          kind: 'loadMedia',
          mxc,
          encryptedFile: ef,
          mime: body.info.mimetype,
        });
        const blob = new Blob([res.data], { type: res.mime });
        return { loaded: { url: URL.createObjectURL(blob), mime: res.mime }, error: null };
      } catch (err) {
        // Surface the actual failure inline instead of silently rendering
        // "unavailable" — the user is our debugger here, they shouldn't
        // need devtools to know what's broken.
        const msg = err instanceof Error ? err.message : String(err);
        return { loaded: null, error: msg };
      }
    },
  );

  return (
    <div class="my-1">
      <Show
        when={resource()?.loaded}
        fallback={
          <MediaLoading
            body={props.body}
            loading={resource.loading}
            error={resource()?.error ?? null}
          />
        }
      >
        {(r) => <MediaPlayer body={props.body} loaded={r()} />}
      </Show>
    </div>
  );
}

function MediaLoading(props: { body: MediaMessageBody; loading: boolean; error: string | null }) {
  return (
    <div
      class="flex items-center gap-2 rounded-lg border border-line bg-elev px-3 py-2 text-xs text-fg-3"
      title={props.error ?? undefined}
    >
      <span>{props.body.msgtype === 'm.image' ? '🖼️' : props.body.msgtype === 'm.video' ? '🎬' : props.body.msgtype === 'm.audio' ? '🔊' : '📎'}</span>
      <span class="truncate">{props.body.body}</span>
      <span class="ml-auto shrink-0 max-w-[60%] truncate">
        {props.loading ? 'loading…' : props.error ? `failed: ${props.error}` : 'unavailable'}
      </span>
    </div>
  );
}

function MediaPlayer(props: { body: MediaMessageBody; loaded: { url: string; mime: string } }) {
  const c = props.body;
  if (c.msgtype === 'm.image') {
    const [lightbox, setLightbox] = createSignal(false);
    // Esc / backdrop-click closes the lightbox. We attach a keydown
    // listener only while the overlay is open so we don't capture Esc
    // globally (the rest of the app uses it for cancel-reply etc).
    createEffect(() => {
      if (!lightbox()) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setLightbox(false);
      };
      window.addEventListener('keydown', onKey);
      onCleanup(() => window.removeEventListener('keydown', onKey));
    });
    return (
      <>
        <img
          src={props.loaded.url}
          alt={c.body}
          class="max-h-80 max-w-full cursor-zoom-in rounded-lg object-contain"
          onClick={() => setLightbox(true)}
        />
        <Show when={lightbox()}>
          <div
            class="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
            onClick={() => setLightbox(false)}
            role="dialog"
            aria-label="Image preview"
          >
            <img
              src={props.loaded.url}
              alt={c.body}
              class="max-h-full max-w-full cursor-zoom-out rounded-lg object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox(false);
              }}
              class="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm hover:bg-white/20"
              aria-label="Close (Esc)"
              title="Close (Esc)"
            >
              ✕
            </button>
            <a
              href={props.loaded.url}
              download={c.body}
              onClick={(e) => e.stopPropagation()}
              class="absolute bottom-4 right-4 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-white/20"
              title="Download"
            >
              Download
            </a>
          </div>
        </Show>
      </>
    );
  }
  if (c.msgtype === 'm.video') {
    return <video src={props.loaded.url} controls class="max-h-80 max-w-full rounded-lg" />;
  }
  if (c.msgtype === 'm.audio') {
    return <audio src={props.loaded.url} controls class="w-full" />;
  }
  // m.file
  return (
    <a
      href={props.loaded.url}
      download={c.body}
      class="flex items-center gap-2 rounded-lg border border-line bg-elev px-3 py-2 text-xs text-fg-2 hover:bg-input"
    >
      <span>📎</span>
      <span class="truncate">{c.body}</span>
      <span class="ml-auto shrink-0 text-[10px] text-fg-3">
        {formatBytes(c.info.size)}
      </span>
    </a>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Re-export to satisfy the Resource type import (avoids unused import
// warning while keeping the type available for future signatures).
export type _MediaResource = Resource<{ url: string; mime: string } | null>;
