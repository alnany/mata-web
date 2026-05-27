import { createSignal, For, Show } from 'solid-js';
import type {
  EventId,
  ReactionAggregate,
  RoomMessageEvent,
  TimelineEvent,
  UserId,
} from '@mata/shared/matrix';
import { shortTime } from '../lib/date-buckets.js';
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
};

export function MessageBubble(props: {
  ev: TimelineEvent;
  me: UserId | null;
  showHeader: boolean;
  inReplyToEvent?: TimelineEvent;
  actions: MessageActions;
}) {
  const isMine = () => props.ev.sender === props.me;
  const [showMenu, setShowMenu] = createSignal(false);
  const [showEmoji, setShowEmoji] = createSignal(false);

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
      class={`msg-enter group flex ${isMine() ? 'justify-end' : 'justify-start'} ${
        props.showHeader ? 'mt-3' : 'mt-0.5'
      }`}
      data-event-id={msg.eventId}
      onMouseLeave={() => {
        setShowMenu(false);
        setShowEmoji(false);
      }}
    >
      {/* Left gutter avatar for non-mine */}
      <Show when={!isMine()}>
        <div class="mr-2 w-8 shrink-0">
          <Show when={props.showHeader}>
            <div
              class="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-300 text-xs font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
              title={msg.sender}
            >
              {initials(msg.sender)}
            </div>
          </Show>
        </div>
      </Show>

      <div class="relative max-w-[78%]">
        <Show when={props.showHeader && !isMine()}>
          <div class="mb-0.5 text-[11px] font-semibold text-neutral-600 dark:text-neutral-400">
            {prettyName(msg.sender)}
          </div>
        </Show>

        <div
          class={`relative rounded-2xl px-3 py-2 text-sm leading-5 ${
            isMine()
              ? 'bg-mata-500 text-white'
              : 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
          }`}
        >
          {/* Reply preview strip */}
          <Show when={msg.inReplyTo && props.inReplyToEvent}>
            <button
              type="button"
              onClick={() => props.actions.onJumpTo(msg.inReplyTo as EventId)}
              class={`-mx-1 mb-1.5 block w-[calc(100%+0.5rem)] truncate rounded-md border-l-2 px-2 py-1 text-left text-[11px] leading-4 transition-opacity hover:opacity-100 ${
                isMine()
                  ? 'border-white/70 bg-white/10 opacity-90'
                  : 'border-mata-500 bg-black/5 opacity-80 dark:bg-white/5'
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
            <Body msg={msg} />
          </span>

          <div
            class={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
              isMine() ? 'text-white/70' : 'text-neutral-500'
            }`}
          >
            <Show when={edited}>
              <span title={`Edited (${msg.edits.length}× revisions)`} class="italic">
                edited
              </span>
              <span>·</span>
            </Show>
            <span>{shortTime(msg.originServerTs)}</span>
          </div>

          {/* Hover actions */}
          <div
            class={`absolute -top-3 ${isMine() ? 'left-0 -translate-x-full pr-1' : 'right-0 translate-x-full pl-1'} hidden group-hover:flex`}
          >
            <div class="flex items-center gap-0.5 rounded-full border border-neutral-200 bg-white px-1 py-0.5 shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
              <ActionBtn title="React" onClick={() => setShowEmoji((v) => !v)}>
                😀
              </ActionBtn>
              <ActionBtn title="Reply" onClick={() => props.actions.onReply(msg)}>
                ↩
              </ActionBtn>
              <ActionBtn title="More" onClick={() => setShowMenu((v) => !v)}>
                ⋯
              </ActionBtn>
            </div>
          </div>

          {/* Quick emoji popover */}
          <Show when={showEmoji()}>
            <div class={`absolute z-30 -top-2 ${isMine() ? 'right-0' : 'left-0'} translate-y-[-100%]`}>
              <EmojiPicker
                onPick={(e) => {
                  props.actions.onReact(msg.eventId, e);
                  setShowEmoji(false);
                }}
                onClose={() => setShowEmoji(false)}
              />
            </div>
          </Show>

          {/* Overflow menu */}
          <Show when={showMenu()}>
            <div
              class={`absolute z-30 mt-1 min-w-[160px] rounded-lg border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900 ${
                isMine() ? 'right-0' : 'left-0'
              }`}
            >
              <MenuItem onClick={() => { props.actions.onReply(msg); setShowMenu(false); }}>
                Reply
              </MenuItem>
              <MenuItem onClick={copyText}>Copy text</MenuItem>
              <MenuItem onClick={copyPermalink}>Copy link</MenuItem>
              <Show when={isMine() && msg.content.msgtype === 'm.text'}>
                <MenuItem onClick={() => { props.actions.onEdit(msg); setShowMenu(false); }}>
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

function ActionBtn(props: { title: string; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      class="flex h-7 w-7 items-center justify-center rounded-full text-base text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      {props.children}
    </button>
  );
}

function MenuItem(props: { onClick: () => void; destructive?: boolean; children: any }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`block w-full px-3 py-1.5 text-left transition-colors ${
        props.destructive
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
          : 'text-neutral-800 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800'
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
          : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800'
      }`}
      title={`${props.r.count} reaction${props.r.count === 1 ? '' : 's'}`}
    >
      <span>{props.r.key}</span>
      <span class="text-[11px]">{props.r.count}</span>
    </button>
  );
}

function Body(props: { msg: RoomMessageEvent }) {
  const c = props.msg.content;
  if (c.msgtype === 'm.text' || c.msgtype === 'm.notice' || c.msgtype === 'm.emote') {
    return c.body;
  }
  return `[${c.msgtype}] ${c.body}`;
}

function SystemRow(props: { ev: TimelineEvent }) {
  const text = () => {
    const ev = props.ev;
    if (ev.type === 'm.room.encrypted') return '🔒 Encrypted message (E2EE rollout pending)';
    if (ev.type === 'm.room.member') return 'membership change';
    if (ev.type === 'm.room.redaction') return 'message removed';
    return 'system event';
  };
  return (
    <li class="my-1 flex justify-center">
      <span class="rounded-full bg-neutral-100 px-3 py-1 text-[11px] italic text-neutral-500 dark:bg-neutral-900">
        {text()}
      </span>
    </li>
  );
}

function initials(userId: string): string {
  const localpart = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  return localpart.slice(0, 2).toUpperCase();
}

function prettyName(userId: string): string {
  const localpart = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  return localpart;
}

function previewOf(ev: TimelineEvent): string {
  if (ev.type === 'm.room.message') {
    const c = ev.content;
    if ('body' in c) return c.body;
  }
  if (ev.type === 'm.room.encrypted') return '🔒 encrypted';
  return '…';
}

export { initials, prettyName };
