import { createSignal, Show } from 'solid-js';
import type { RoomSummary } from '@mata/shared/matrix';
import { prettyName } from './message-bubble.js';
import { useBridge } from '../bridge/context.js';
import { activeCall, placeCall } from '../stores/call.js';
import { showToast } from '../stores/toast.js';

/**
 * Conversation header — design layout (HANDOFF.md §"Conversation header"):
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ #room-name  [e2ee · cross-signed]                            │
 *   │ topic · !roomId:server                       [members] 🔍📌📞 │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Typing activity replaces the topic line transiently.
 */
export function RoomHeader(props: {
  room: RoomSummary;
  typingUserIds: string[];
  onShowMembers?: () => void;
  membersOpen?: boolean;
  onShowSearch?: () => void;
  searchOpen?: boolean;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [infoOpen, setInfoOpen] = createSignal(false);
  const [muting, setMuting] = createSignal(false);
  const bridge = useBridge();

  const toggleMute = async () => {
    if (muting()) return;
    setMuting(true);
    setMenuOpen(false);
    try {
      await bridge.request({
        kind: 'setRoomMuted',
        roomId: props.room.roomId,
        muted: !props.room.isMuted,
      });
    } catch {
      /* sync delta will reveal real state */
    } finally {
      setMuting(false);
    }
  };

  const subtitle = () => {
    const typers = props.typingUserIds.filter((u) => u !== '');
    if (typers.length === 0) return props.room.topic || '';
    if (typers.length === 1) return `${prettyName(typers[0])} is typing…`;
    if (typers.length === 2) return `${prettyName(typers[0])} and ${prettyName(typers[1])} are typing…`;
    return `${typers.length} people are typing…`;
  };

  return (
    <header
      class="relative flex items-start justify-between gap-3 border-b px-[22px] py-[14px]"
      style={{ 'border-color': 'var(--color-line)' }}
    >
      <div class="min-w-0 flex-1">
        {/* Top line: # + name + encryption pill */}
        <div class="flex items-center gap-2">
          <h1
            class="flex min-w-0 items-baseline gap-[2px] truncate text-[17px] leading-none text-fg"
            style={{ 'font-weight': 500, 'letter-spacing': '-0.01em' }}
          >
            <Show
              when={props.room.type !== 'direct'}
              fallback={<span class="dot-accent mr-1" style={{ display: 'inline-block' }} />}
            >
              <span class="text-fg-4" style={{ 'font-weight': 400 }}>
                #
              </span>
            </Show>
            <span class="truncate">{props.room.name}</span>
          </h1>
          <Show when={props.room.isEncrypted}>
            <EncryptionPill />
          </Show>
          <Show when={props.room.isMuted}>
            <span
              class="mono rounded-[6px] border px-[6px] py-[2px] text-[10px] text-fg-4"
              style={{ 'border-color': 'var(--color-line)' }}
              title="Muted"
            >
              muted
            </span>
          </Show>
        </div>
        {/* Bottom line: topic · roomId */}
        <div class="mt-[3px] flex min-w-0 items-baseline gap-[6px]">
          <Show when={subtitle()}>
            <span class="truncate text-[12.5px] text-fg-3">{subtitle()}</span>
            <span class="text-fg-4" style={{ 'font-size': '8px' }}>
              •
            </span>
          </Show>
          <span class="mono shrink min-w-0 truncate text-[11px] text-fg-4">
            {props.room.roomId}
          </span>
        </div>
      </div>

      {/* Right action group */}
      <div class="flex shrink-0 items-center gap-[2px]">
        <Show when={props.onShowSearch}>
          <HeaderIconButton
            onClick={props.onShowSearch!}
            active={props.searchOpen}
            label="Search messages (⌘F)"
          >
            <IconSearch class="h-[14px] w-[14px]" />
          </HeaderIconButton>
        </Show>
        <Show when={props.onShowMembers}>
          <HeaderIconButton
            onClick={props.onShowMembers!}
            active={props.membersOpen}
            label="People"
          >
            <IconUsers class="h-[14px] w-[14px]" />
          </HeaderIconButton>
        </Show>
        <CallButton room={props.room} media="audio" label="Voice call">
          <IconPhone class="h-[14px] w-[14px]" />
        </CallButton>
        <CallButton room={props.room} media="video" label="Video call">
          <IconVideo class="h-[14px] w-[14px]" />
        </CallButton>
        <HeaderIconButton onClick={() => setMenuOpen((v) => !v)} label="More">
          <IconMore class="h-[14px] w-[14px]" />
        </HeaderIconButton>
      </div>

      <Show when={menuOpen()}>
        <div
          class="absolute right-[18px] top-[58px] z-20 min-w-[180px] overflow-hidden rounded-[8px] border bg-elev py-1 text-[12.5px]"
          style={{ 'border-color': 'var(--color-line)' }}
          onMouseLeave={() => setMenuOpen(false)}
        >
          <MenuItem
            onClick={() => {
              setInfoOpen(true);
              setMenuOpen(false);
            }}
          >
            Room info
          </MenuItem>
          <MenuItem onClick={toggleMute} disabled={muting()}>
            {props.room.isMuted ? 'Unmute notifications' : 'Mute notifications'}
          </MenuItem>
        </div>
      </Show>

      <Show when={infoOpen()}>
        <RoomInfoModal room={props.room} onClose={() => setInfoOpen(false)} />
      </Show>
    </header>
  );
}

/* =========================================================================
   Encryption pill — design spec
   ========================================================================= */

function EncryptionPill() {
  return (
    <span
      class="mono inline-flex items-center gap-[5px] rounded-full border px-[7px] py-[2px] text-[11px] text-fg-2"
      style={{ 'border-color': 'var(--color-line)', 'letter-spacing': '0.02em' }}
      title="End-to-end encrypted · cross-signed"
    >
      <span class="dot-accent" />
      <span>e2ee · cross-signed</span>
    </span>
  );
}

function HeaderIconButton(props: {
  onClick: () => void;
  label: string;
  active?: boolean;
  children: any;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-fg-3 transition-colors hover:bg-elev hover:text-fg"
      style={{
        background: props.active ? 'var(--color-elev)' : 'transparent',
        color: props.active ? 'var(--color-fg)' : undefined,
      }}
      aria-label={props.label}
      title={props.label}
    >
      {props.children}
    </button>
  );
}

function MenuItem(props: { onClick: () => void; disabled?: boolean; children: any }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      class="block w-full px-3 py-[6px] text-left text-fg-2 hover:bg-elev hover:text-fg disabled:cursor-not-allowed disabled:text-fg-4"
    >
      {props.children}
    </button>
  );
}

function RoomInfoModal(props: { room: RoomSummary; onClose: () => void }) {
  const r = props.room;
  return (
    <div class="fixed inset-0 z-30 flex items-center justify-center" role="dialog" aria-modal>
      <div class="absolute inset-0 bg-black/50" onClick={props.onClose} />
      <div
        class="relative z-10 w-96 max-w-[90vw] rounded-[14px] border bg-elev p-5"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        <div class="flex items-start justify-between">
          <h3 class="text-[15px] text-fg" style={{ 'font-weight': 500 }}>
            {r.name}
          </h3>
          <button
            type="button"
            onClick={props.onClose}
            class="rounded-[6px] p-1 text-fg-3 hover:bg-input hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <dl class="mt-4 space-y-2 text-[13px]">
          <Row label="Type">{r.type}</Row>
          <Row label="Encrypted">{r.isEncrypted ? 'yes' : 'no'}</Row>
          <Row label="Room ID">
            <span class="mono break-all text-[11px] text-fg-3">{r.roomId}</span>
          </Row>
          <Show when={r.topic}>
            <Row label="Topic">{r.topic}</Row>
          </Show>
        </dl>
      </div>
    </div>
  );
}

function Row(props: { label: string; children: any }) {
  return (
    <div class="flex gap-3">
      <dt class="mono w-24 shrink-0 text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
        {props.label}
      </dt>
      <dd class="flex-1 text-fg-2">{props.children}</dd>
    </div>
  );
}

function CallButton(props: {
  room: RoomSummary;
  media: 'audio' | 'video';
  label: string;
  children: any;
}) {
  const isBusy = () => activeCall() != null && activeCall()?.state !== 'ended';
  const onClick = async () => {
    if (isBusy()) return;
    try {
      await placeCall(props.room.roomId, null, props.media);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not start the call');
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isBusy()}
      class="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-fg-3 transition-colors hover:bg-elev hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      aria-label={props.label}
      title={props.label}
    >
      {props.children}
    </button>
  );
}

/* =========================================================================
   Icons
   ========================================================================= */

function IconSearch(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function IconUsers(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconPhone(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}
function IconVideo(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class={p.class}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}
function IconMore(p: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" class={p.class}>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
