import { createResource, createSignal, onMount, For, Show } from 'solid-js';
import type { RoomMember, RoomSummary, UserId } from '@mata/shared/matrix';
import { prettyName, initials, gradientForUser } from './message-bubble.js';
import { PresenceDot } from './presence-dot.js';
import { useBridge } from '../bridge/context.js';
import { activeCall, placeCall } from '../stores/call.js';
import { showToast } from '../stores/toast.js';
import { presenceOf, lastSeenLabel, ensurePresence } from '../stores/presence.js';
import { session } from '../stores/session.js';

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
  /** Called after the user leaves/forgets this room from settings. */
  onLeft?: () => void;
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

  // DM peer (if any) — drives the online dot + "last seen" subtitle.
  const dmPeer = (): UserId | null =>
    props.room.type === 'dm' ? (props.room.dmTargetUserId ?? null) : null;
  onMount(() => {
    const peer = dmPeer();
    if (peer) ensurePresence(bridge, peer);
  });

  const subtitle = () => {
    const typers = props.typingUserIds.filter((u) => u !== '');
    if (typers.length === 1) return `${prettyName(typers[0])} is typing…`;
    if (typers.length === 2) return `${prettyName(typers[0])} and ${prettyName(typers[1])} are typing…`;
    if (typers.length > 2) return `${typers.length} people are typing…`;
    // No one typing — for a DM prefer the peer's presence ("online" /
    // "last seen 5m ago"); fall back to the room topic otherwise.
    const peer = dmPeer();
    if (peer) {
      const label = lastSeenLabel(presenceOf(peer));
      if (label) return label;
    }
    return props.room.topic || '';
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
              when={props.room.type !== 'dm'}
              fallback={
                <Show when={dmPeer()} fallback={<span class="dot-accent mr-1" style={{ display: 'inline-block' }} />}>
                  <span class="relative mr-1 inline-flex h-2.5 w-2.5 items-center justify-center">
                    <PresenceDot userId={dmPeer()!} />
                  </span>
                </Show>
              }
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
            Room settings
          </MenuItem>
          <MenuItem onClick={toggleMute} disabled={muting()}>
            {props.room.isMuted ? 'Unmute notifications' : 'Mute notifications'}
          </MenuItem>
        </div>
      </Show>

      <Show when={infoOpen()}>
        <RoomSettingsModal
          room={props.room}
          onClose={() => setInfoOpen(false)}
          onLeft={props.onLeft}
        />
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

/**
 * Room settings (Phase 1) — Overview tab. Edit the room name + topic,
 * power-level gated: the worker resolves `maySendStateEvent` for
 * `m.room.name` / `m.room.topic` and we render the fields read-only
 * (or show a "no permission" note) when the user can't change them.
 * State metadata (type / encrypted / room id) stays as a read-only
 * footer. DMs have no display name to edit, so the name field falls
 * back to read-only there too via the same power gate.
 */
function RoomSettingsModal(props: {
  room: RoomSummary;
  onClose: () => void;
  onLeft?: () => void;
}) {
  const r = props.room;
  const bridge = useBridge();
  const s = session();
  const me: UserId | null = s.phase === 'authenticated' ? s.userId : null;
  const [name, setName] = createSignal('');
  const [topic, setTopic] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [uploadingAvatar, setUploadingAvatar] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);
  const [confirmLeave, setConfirmLeave] = createSignal(false);
  const [savingRole, setSavingRole] = createSignal<string | null>(null);
  // Pending moderation action awaiting inline confirmation.
  const [pendingMod, setPendingMod] = createSignal<{
    userId: UserId;
    name: string;
    action: 'kick' | 'ban';
  } | null>(null);
  const [modBusy, setModBusy] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;

  const [settings] = createResource(
    () => r.roomId,
    async (roomId) => {
      const res = await bridge.request({ kind: 'fetchRoomSettings', roomId });
      if (res.kind === 'fetchRoomSettings') {
        setName(res.name);
        setTopic(res.topic);
        return res;
      }
      return null;
    },
  );

  // Member roster for the roles section. Joined members only — pending
  // invites / left users aren't role-editable here.
  const [members, { refetch: refetchMembers }] = createResource(
    () => r.roomId,
    async (roomId) => {
      const res = await bridge.request({ kind: 'loadRoomMembers', roomId });
      if (res.kind !== 'loadRoomMembers') return [] as RoomMember[];
      return res.members.filter((m) => m.membership === 'join');
    },
  );

  const canSetName = () => settings()?.canSetName ?? false;
  const canSetTopic = () => settings()?.canSetTopic ?? false;
  const canSetAvatar = () => settings()?.canSetAvatar ?? false;
  const canSetPowerLevel = () => settings()?.canSetPowerLevel ?? false;
  const canKick = () => settings()?.canKick ?? false;
  const canBan = () => settings()?.canBan ?? false;
  const myPower = () => settings()?.myPowerLevel ?? 0;

  // Moderation is allowed only against members strictly below our own
  // level (never ourselves, peers, or superiors), and only when the room
  // grants us the kick / ban power.
  const canKickMember = (m: RoomMember) =>
    canKick() && m.userId !== me && m.powerLevel < myPower();
  const canBanMember = (m: RoomMember) =>
    canBan() && m.userId !== me && m.powerLevel < myPower();

  const ROLES: { label: string; value: number }[] = [
    { label: 'Admin', value: 100 },
    { label: 'Moderator', value: 50 },
    { label: 'Member', value: 0 },
  ];
  const roleLabel = (pl: number) =>
    pl >= 100 ? 'Admin' : pl >= 50 ? 'Moderator' : 'Member';

  // We may only change a member's role when: the power-levels event is
  // editable by us, the target isn't ourselves, and the target's current
  // level is strictly below ours (can't touch peers or superiors).
  const canEditMember = (m: RoomMember) =>
    canSetPowerLevel() && m.userId !== me && m.powerLevel < myPower();

  const changeRole = async (m: RoomMember, value: number) => {
    if (value === m.powerLevel || value >= myPower()) return;
    setSavingRole(m.userId);
    try {
      await bridge.request({
        kind: 'setMemberPowerLevel',
        roomId: r.roomId,
        userId: m.userId,
        powerLevel: value,
      });
      showToast('success', `${prettyName(m.displayname, m.userId)} is now ${roleLabel(value)}`);
      await refetchMembers();
    } catch (err) {
      showToast('error', `Could not change role: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setSavingRole(null);
    }
  };

  const runMod = async () => {
    const p = pendingMod();
    if (!p || modBusy()) return;
    setModBusy(true);
    try {
      await bridge.request(
        p.action === 'kick'
          ? { kind: 'kickFromRoom', roomId: r.roomId, userId: p.userId, reason: null }
          : { kind: 'banFromRoom', roomId: r.roomId, userId: p.userId, reason: null },
      );
      showToast('success', p.action === 'kick' ? `${p.name} removed` : `${p.name} banned`);
      setPendingMod(null);
      await refetchMembers();
    } catch (err) {
      showToast(
        'error',
        `Could not ${p.action === 'kick' ? 'remove' : 'ban'} member: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      setModBusy(false);
    }
  };

  const leaveRoom = async () => {
    if (leaving()) return;
    setLeaving(true);
    try {
      await bridge.request({ kind: 'forgetRoom', roomId: r.roomId });
      showToast('success', 'You left the room');
      props.onClose();
      props.onLeft?.();
    } catch (err) {
      showToast('error', `Could not leave: ${err instanceof Error ? err.message : 'unknown error'}`);
      setLeaving(false);
    }
  };

  const onPickAvatar = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || uploadingAvatar()) return;
    if (!file.type.startsWith('image/')) {
      showToast('error', 'Pick an image file');
      return;
    }
    setUploadingAvatar(true);
    try {
      const data = await file.arrayBuffer();
      const up = await bridge.request({
        kind: 'uploadMedia',
        data,
        mime: file.type,
        filename: file.name,
      });
      if (up.kind !== 'uploadMedia') throw new Error('upload failed');
      await bridge.request({ kind: 'setRoomAvatar', roomId: r.roomId, mxc: up.mxc });
      showToast('success', 'Room photo updated');
    } catch (err) {
      showToast('error', `Could not update photo: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setUploadingAvatar(false);
    }
  };
  const loaded = () => settings() !== undefined;
  const readOnly = () => loaded() && !canSetName() && !canSetTopic();
  const dirty = () =>
    (canSetName() && name().trim() !== (settings()?.name ?? '')) ||
    (canSetTopic() && topic().trim() !== (settings()?.topic ?? ''));

  const save = async () => {
    if (saving() || !dirty()) return;
    setSaving(true);
    try {
      const s = settings();
      if (canSetName() && name().trim() !== (s?.name ?? '')) {
        await bridge.request({ kind: 'setRoomName', roomId: r.roomId, name: name().trim() });
      }
      if (canSetTopic() && topic().trim() !== (s?.topic ?? '')) {
        await bridge.request({ kind: 'setRoomTopic', roomId: r.roomId, topic: topic().trim() });
      }
      showToast('success', 'Room updated');
      props.onClose();
    } catch (err) {
      showToast('error', `Could not save: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    'w-full rounded-lg border border-line bg-elev px-3 py-2 text-sm text-fg placeholder:text-fg-4 focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20 disabled:cursor-not-allowed disabled:text-fg-3';

  return (
    <div class="fixed inset-0 z-30 flex items-center justify-center" role="dialog" aria-modal>
      <div class="absolute inset-0 bg-black/50" onClick={props.onClose} />
      <div
        class="relative z-10 w-96 max-w-[90vw] rounded-[14px] border bg-elev p-5"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        <div class="flex items-start justify-between">
          <h3 class="text-[15px] text-fg" style={{ 'font-weight': 500 }}>
            Room settings
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

        <div class="mt-4 flex items-center gap-3">
          <div class="relative h-16 w-16 shrink-0">
            <Show
              when={r.avatarUrl}
              fallback={
                <div
                  class="flex h-16 w-16 items-center justify-center rounded-full text-[20px]"
                  style={{
                    background: gradientForUser(r.roomId).background,
                    color: gradientForUser(r.roomId).color,
                    'font-weight': 600,
                  }}
                >
                  {initials(r.name || r.roomId)}
                </div>
              }
            >
              <img
                src={r.avatarUrl}
                alt=""
                class="h-16 w-16 rounded-full object-cover"
              />
            </Show>
            <Show when={uploadingAvatar()}>
              <div class="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-[10px] text-white">
                …
              </div>
            </Show>
          </div>
          <Show when={canSetAvatar()}>
            <div>
              <input
                ref={(el) => (fileInput = el)}
                type="file"
                accept="image/*"
                class="hidden"
                onChange={(e) => void onPickAvatar(e)}
              />
              <button
                type="button"
                onClick={() => fileInput?.click()}
                disabled={uploadingAvatar()}
                class="rounded-lg border border-line px-3 py-1.5 text-[13px] text-fg-2 hover:bg-input disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploadingAvatar() ? 'Uploading…' : 'Change photo'}
              </button>
            </div>
          </Show>
        </div>

        <div class="mt-4 space-y-3">
          <div>
            <label class="mono mb-1 block text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
              Name
            </label>
            <input
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              disabled={!canSetName()}
              placeholder="Room name"
              class={fieldClass}
            />
          </div>
          <div>
            <label class="mono mb-1 block text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
              Topic
            </label>
            <textarea
              value={topic()}
              onInput={(e) => setTopic(e.currentTarget.value)}
              disabled={!canSetTopic()}
              placeholder="What's this room about?"
              rows={3}
              class={`${fieldClass} resize-none`}
            />
          </div>
        </div>

        <Show when={readOnly()}>
          <p class="mt-3 text-[11.5px] text-fg-3">
            You don't have permission to change this room's settings.
          </p>
        </Show>

        <Show when={!readOnly()}>
          <div class="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={props.onClose}
              class="rounded-lg border border-line px-3 py-1.5 text-[13px] text-fg-2 hover:bg-input"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty() || saving()}
              class="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-ink transition-[filter] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving() ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Show>

        <Show when={(members() ?? []).length > 0}>
          <div class="mt-5 border-t pt-4" style={{ 'border-color': 'var(--color-line)' }}>
            <div class="mono mb-2 text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
              Members &amp; roles
            </div>
            <ul class="max-h-56 space-y-1 overflow-y-auto">
              <For each={members()}>
                {(m) => (
                  <li class="rounded-lg px-1 py-1">
                    <Show
                      when={pendingMod()?.userId === m.userId}
                      fallback={
                        <div class="flex items-center gap-2">
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-[13px] text-fg">
                              {prettyName(m.displayname, m.userId)}
                              <Show when={m.userId === me}>
                                <span class="ml-1 text-[10px] text-fg-3">(you)</span>
                              </Show>
                            </div>
                            <div class="mono truncate text-[10px] text-fg-4">{m.userId}</div>
                          </div>
                          <Show
                            when={canEditMember(m)}
                            fallback={
                              <span class="shrink-0 text-[11px] text-fg-3">{roleLabel(m.powerLevel)}</span>
                            }
                          >
                            <select
                              value={ROLES.find((x) => x.value === m.powerLevel)?.value ?? m.powerLevel}
                              disabled={savingRole() === m.userId}
                              onChange={(e) => void changeRole(m, Number(e.currentTarget.value))}
                              class="shrink-0 rounded-md border border-line bg-elev px-2 py-1 text-[12px] text-fg-2 focus:border-mata-500 focus:outline-none disabled:opacity-50"
                            >
                              <For each={ROLES.filter((x) => x.value < myPower() || x.value === m.powerLevel)}>
                                {(role) => <option value={role.value}>{role.label}</option>}
                              </For>
                            </select>
                          </Show>
                          <Show when={canKickMember(m)}>
                            <button
                              type="button"
                              title="Remove from room"
                              onClick={() =>
                                setPendingMod({
                                  userId: m.userId,
                                  name: prettyName(m.displayname, m.userId),
                                  action: 'kick',
                                })
                              }
                              class="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-fg-3 transition-colors hover:bg-input hover:text-fg-2"
                            >
                              Remove
                            </button>
                          </Show>
                          <Show when={canBanMember(m)}>
                            <button
                              type="button"
                              title="Ban from room"
                              onClick={() =>
                                setPendingMod({
                                  userId: m.userId,
                                  name: prettyName(m.displayname, m.userId),
                                  action: 'ban',
                                })
                              }
                              class="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-red-500/80 transition-colors hover:bg-red-500/10 hover:text-red-500"
                            >
                              Ban
                            </button>
                          </Show>
                        </div>
                      }
                    >
                      <div class="flex items-center gap-2 rounded-lg bg-input/60 px-2 py-1.5">
                        <span class="min-w-0 flex-1 truncate text-[12px] text-fg-2">
                          {pendingMod()!.action === 'kick' ? 'Remove' : 'Ban'}{' '}
                          <span class="font-medium text-fg">{pendingMod()!.name}</span>?
                        </span>
                        <button
                          type="button"
                          onClick={() => setPendingMod(null)}
                          disabled={modBusy()}
                          class="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-fg-2 hover:bg-elev disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void runMod()}
                          disabled={modBusy()}
                          class="shrink-0 rounded-md bg-red-500 px-2 py-1 text-[11px] font-semibold text-white transition-[filter] hover:brightness-95 disabled:opacity-50"
                        >
                          {modBusy()
                            ? 'Working…'
                            : pendingMod()!.action === 'kick'
                              ? 'Remove'
                              : 'Ban'}
                        </button>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={!canSetPowerLevel()}>
              <p class="mt-2 text-[11px] text-fg-3">
                You don't have permission to change member roles.
              </p>
            </Show>
          </div>
        </Show>

        <div class="mt-4 border-t pt-4" style={{ 'border-color': 'var(--color-line)' }}>
          <Show
            when={confirmLeave()}
            fallback={
              <button
                type="button"
                onClick={() => setConfirmLeave(true)}
                class="w-full rounded-lg border border-red-500/40 px-3 py-2 text-[13px] font-medium text-red-500 transition-colors hover:bg-red-500/10"
              >
                Leave room
              </button>
            }
          >
            <p class="mb-2 text-[12px] text-fg-2">
              Leave this room? It'll be removed from your list. You'll need a new invite to rejoin.
            </p>
            <div class="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmLeave(false)}
                disabled={leaving()}
                class="flex-1 rounded-lg border border-line px-3 py-1.5 text-[13px] text-fg-2 hover:bg-input disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void leaveRoom()}
                disabled={leaving()}
                class="flex-1 rounded-lg bg-red-500 px-3 py-1.5 text-[13px] font-semibold text-white transition-[filter] hover:brightness-95 disabled:opacity-50"
              >
                {leaving() ? 'Leaving…' : 'Leave room'}
              </button>
            </div>
          </Show>
        </div>

        <dl
          class="mt-5 space-y-2 border-t pt-4 text-[13px]"
          style={{ 'border-color': 'var(--color-line)' }}
        >
          <Row label="Type">{r.type}</Row>
          <Row label="Encrypted">{r.isEncrypted ? 'yes' : 'no'}</Row>
          <Row label="Room ID">
            <span class="mono break-all text-[11px] text-fg-3">{r.roomId}</span>
          </Row>
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
