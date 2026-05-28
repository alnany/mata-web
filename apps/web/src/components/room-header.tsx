import { createSignal, Show } from 'solid-js';
import type { RoomSummary } from '@mata/shared/matrix';
import { initials, prettyName } from './message-bubble.js';
import { useBridge } from '../bridge/context.js';
import { activeCall, placeCall } from '../stores/call.js';
import { showToast } from '../stores/toast.js';

/**
 * Header for the active room: avatar (initials placeholder), name + member
 * preview, encryption indicator, overflow menu (room info read-only,
 * future: mute, leave). Avatar image rendering waits on the mxc → http
 * resolver in Phase 4B.
 */
export function RoomHeader(props: {
  room: RoomSummary;
  typingUserIds: string[];
  onShowMembers?: () => void;
  membersOpen?: boolean;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [infoOpen, setInfoOpen] = createSignal(false);
  const [muting, setMuting] = createSignal(false);
  const bridge = useBridge();

  // Phase 12: server-driven mute toggle. We call the RPC, then trust
  // the next sync delta to refresh `RoomSummary.isMuted` (toSummary
  // re-reads the push rule). The local `muting` flag covers the
  // round-trip so the menu item shows a transitional disabled state.
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
      // Quietly. The next sync delta will reveal the real state; no
      // value in surfacing a network/permission error mid-menu.
    } finally {
      setMuting(false);
    }
  };

  const subtitle = () => {
    const typers = props.typingUserIds.filter((u) => u !== ''); // safety
    if (typers.length === 0) {
      return props.room.topic || props.room.roomId;
    }
    if (typers.length === 1) return `${prettyName(typers[0])} is typing…`;
    if (typers.length === 2)
      return `${prettyName(typers[0])} and ${prettyName(typers[1])} are typing…`;
    return `${typers.length} people are typing…`;
  };

  return (
    <header class="relative flex items-center gap-3 border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
      <div class="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
        {initials(props.room.name)}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-sm font-semibold">{props.room.name}</span>
          <Show when={props.room.isEncrypted}>
            <span title="Encrypted room" class="text-[11px] text-emerald-600 dark:text-emerald-400">
              🔒
            </span>
          </Show>
          <Show when={props.room.isMuted}>
            <span title="Muted" class="text-[11px] text-neutral-500">
              🔕
            </span>
          </Show>
        </div>
        <div class="truncate text-[11px] text-neutral-500">{subtitle()}</div>
      </div>
      {/* Phase 14.1 — call buttons. Visible only when no other call is
          in flight; we disable rather than hide so the buttons keep
          their slot in the header layout (no jumping on press). The
          peer userId is left null in v0: any joined user in the room
          can answer per spec, and the first answer's sender becomes
          the peer for the duration of the call. For DM rooms with
          exactly two members we could pin the peer up-front; that
          refinement is a Phase 14.2 task. */}
      <CallButton
        room={props.room}
        media="audio"
        label="📞"
        title="Voice call"
        ariaLabel="Start voice call"
      />
      <CallButton
        room={props.room}
        media="video"
        label="🎥"
        title="Video call"
        ariaLabel="Start video call"
      />
      <Show when={props.onShowMembers}>
        <button
          type="button"
          onClick={props.onShowMembers}
          class="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          classList={{
            'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100':
              props.membersOpen,
          }}
          aria-label="Show members"
          title="People in this room"
        >
          👥
        </button>
      </Show>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        class="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        aria-label="Room menu"
      >
        ⋯
      </button>

      <Show when={menuOpen()}>
        <div
          class="absolute right-3 top-14 z-20 min-w-[180px] rounded-lg border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          onMouseLeave={() => setMenuOpen(false)}
        >
          <button
            type="button"
            class="block w-full px-3 py-1.5 text-left text-neutral-800 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
            onClick={() => {
              setInfoOpen(true);
              setMenuOpen(false);
            }}
          >
            Room info
          </button>
          <button
            type="button"
            onClick={toggleMute}
            disabled={muting()}
            class="block w-full px-3 py-1.5 text-left text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {props.room.isMuted ? 'Unmute notifications' : 'Mute notifications'}
          </button>
          <button
            type="button"
            disabled
            class="block w-full cursor-not-allowed px-3 py-1.5 text-left text-neutral-400"
            title="Coming soon"
          >
            Leave room
          </button>
        </div>
      </Show>

      <Show when={infoOpen()}>
        <RoomInfoModal room={props.room} onClose={() => setInfoOpen(false)} />
      </Show>
    </header>
  );
}

function RoomInfoModal(props: { room: RoomSummary; onClose: () => void }) {
  const r = props.room;
  return (
    <div class="fixed inset-0 z-30 flex items-center justify-center" role="dialog" aria-modal>
      <div class="absolute inset-0 bg-black/40" onClick={props.onClose} />
      <div class="relative z-10 w-96 max-w-[90vw] rounded-xl bg-white p-5 shadow-2xl dark:bg-neutral-900">
        <div class="flex items-start justify-between">
          <h3 class="text-base font-semibold">{r.name}</h3>
          <button
            type="button"
            onClick={props.onClose}
            class="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <dl class="mt-3 space-y-2 text-sm">
          <Row label="Type">{r.type}</Row>
          <Row label="Encrypted">{r.isEncrypted ? 'yes' : 'no'}</Row>
          <Row label="Room ID">
            <span class="break-all font-mono text-[11px]">{r.roomId}</span>
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
      <dt class="w-24 shrink-0 text-xs font-medium text-neutral-500">{props.label}</dt>
      <dd class="flex-1 text-neutral-800 dark:text-neutral-200">{props.children}</dd>
    </div>
  );
}

/**
 * Header-mounted call-start button. Disabled while another call is
 * active so we don't try to spin a second peer connection. We don't
 * keep our own pending flag — `placeCall` flips `activeCall()` to a
 * non-null snapshot synchronously enough that the disabled state
 * latches before the user can double-click.
 */
function CallButton(props: {
  room: RoomSummary;
  media: 'audio' | 'video';
  label: string;
  title: string;
  ariaLabel: string;
}) {
  const isBusy = () => activeCall() != null && activeCall()?.state !== 'ended';
  const onClick = async () => {
    if (isBusy()) return;
    try {
      await placeCall(props.room.roomId, null, props.media);
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Could not start the call',
      );
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isBusy()}
      class="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      aria-label={props.ariaLabel}
      title={props.title}
    >
      {props.label}
    </button>
  );
}
