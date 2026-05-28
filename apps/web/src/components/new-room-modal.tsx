// ============================================================================
// NewRoomModal — create a private room or a 1:1 DM.
//
// Two modes selectable via a tab strip:
//   - "Room": multi-person private room with name + optional topic. Invitees
//     are comma-separated Matrix IDs (`@user:server`). E2EE on by default;
//     user can untick for a plain room (rare — explained next to the
//     toggle).
//   - "Direct message": exactly one Matrix ID. Name/topic are server-derived
//     ('' lets the homeserver fill it from the member list). Always
//     encrypted; the toggle is hidden.
//
// The modal closes itself after `bridge.request({ kind: 'createRoom' })`
// resolves. The new roomId is reported up via onCreated so the parent
// route can immediately select the room in the sidebar — sync will catch
// up with the actual RoomSummary delta a moment later.
// ============================================================================

import { createSignal, For, Show } from 'solid-js';
import type { RoomId, UserId } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';

type Mode = 'room' | 'dm';

export function NewRoomModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (roomId: RoomId) => void;
}) {
  const bridge = useBridge();
  const [mode, setMode] = createSignal<Mode>('room');
  const [name, setName] = createSignal('');
  const [topic, setTopic] = createSignal('');
  const [invites, setInvites] = createSignal('');
  const [encrypted, setEncrypted] = createSignal(true);
  const [submitting, setSubmitting] = createSignal(false);

  const reset = () => {
    setMode('room');
    setName('');
    setTopic('');
    setInvites('');
    setEncrypted(true);
    setSubmitting(false);
  };

  const close = () => {
    if (submitting()) return;
    reset();
    props.onClose();
  };

  const parseInvites = (raw: string): UserId[] => {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s as UserId);
  };

  const validInvitee = (id: string): boolean => /^@[^:]+:.+/.test(id);

  const submit = async () => {
    if (submitting()) return;
    const inviteList = parseInvites(invites());
    const bad = inviteList.filter((u) => !validInvitee(u));
    if (bad.length > 0) {
      showToast('error', `Bad Matrix IDs: ${bad.join(', ')}`);
      return;
    }
    if (mode() === 'dm') {
      if (inviteList.length !== 1) {
        showToast('error', 'A direct message needs exactly one Matrix ID.');
        return;
      }
    } else if (!name().trim()) {
      showToast('error', 'Room name is required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await bridge.request({
        kind: 'createRoom',
        name: mode() === 'dm' ? '' : name().trim(),
        topic: mode() === 'dm' ? null : topic().trim() || null,
        isDirect: mode() === 'dm',
        encrypted: mode() === 'dm' ? true : encrypted(),
        invite: inviteList,
      });
      props.onCreated(res.roomId);
      showToast('success', mode() === 'dm' ? 'DM created' : 'Room created');
      reset();
      props.onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `Create failed: ${msg}`);
      setSubmitting(false);
    }
  };

  const tabs: { id: Mode; label: string }[] = [
    { id: 'room', label: 'Room' },
    { id: 'dm', label: 'Direct message' },
  ];

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        onClick={close}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <div
          class="w-full max-w-md rounded-2xl bg-elev p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header class="mb-3 flex items-center justify-between">
            <h2 class="text-base font-semibold">New conversation</h2>
            <button
              type="button"
              onClick={close}
              class="rounded-md p-1 text-fg-3 hover:bg-input hover:text-fg"
              aria-label="Close"
              disabled={submitting()}
            >
              ✕
            </button>
          </header>

          <div class="mb-4 inline-flex rounded-lg bg-input p-1">
            <For each={tabs}>
              {(t) => (
                <button
                  type="button"
                  onClick={() => setMode(t.id)}
                  class={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    mode() === t.id
                      ? 'bg-elev text-fg shadow-sm dark:text-white'
                      : 'text-fg-2 hover:text-fg'
                  }`}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>

          <Show when={mode() === 'room'}>
            <Field label="Room name" required>
              <input
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="Project Alpha"
                class="w-full rounded-lg border border-line bg-elev px-3 py-2 text-sm focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20"
              />
            </Field>
            <Field label="Topic (optional)">
              <input
                type="text"
                value={topic()}
                onInput={(e) => setTopic(e.currentTarget.value)}
                placeholder="What's it about?"
                class="w-full rounded-lg border border-line bg-elev px-3 py-2 text-sm focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20"
              />
            </Field>
          </Show>

          <Field
            label={mode() === 'dm' ? 'Matrix ID' : 'Invite (optional)'}
            help={
              mode() === 'dm'
                ? 'The user to DM, e.g. @vito:chat.greatass.me.'
                : 'Comma-separated Matrix IDs to invite. You can also invite people later.'
            }
            required={mode() === 'dm'}
          >
            <input
              type="text"
              value={invites()}
              onInput={(e) => setInvites(e.currentTarget.value)}
              placeholder="@vito:chat.greatass.me"
              autocomplete="off"
              class="w-full rounded-lg border border-line bg-elev px-3 py-2 text-sm focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20"
            />
          </Field>

          <Show when={mode() === 'room'}>
            <label class="mb-4 flex items-start gap-3 rounded-lg border border-line bg-elev px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={encrypted()}
                onChange={(e) => setEncrypted(e.currentTarget.checked)}
                class="mt-0.5 h-4 w-4 rounded text-mata-600 focus:ring-mata-500"
              />
              <span>
                <span class="block font-medium text-fg">
                  End-to-end encrypted 🔒
                </span>
                <span class="text-fg-3">
                  Recommended. Turn off only for a public-style lobby — once a
                  Matrix room is encrypted it can't be unencrypted.
                </span>
              </span>
            </label>
          </Show>

          <footer class="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              disabled={submitting()}
              class="rounded-lg px-3 py-2 text-sm text-fg-2 hover:bg-input disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting()}
              class="rounded-lg bg-mata-600 px-4 py-2 text-sm font-medium text-white hover:bg-mata-500 disabled:opacity-50"
            >
              {submitting() ? 'Creating…' : 'Create'}
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}

function Field(props: {
  label: string;
  help?: string;
  required?: boolean;
  children: any;
}) {
  return (
    <div class="mb-3">
      <label class="mb-1 flex items-center gap-1 text-xs font-medium text-fg-2">
        <span>{props.label}</span>
        <Show when={props.required}>
          <span class="text-red-500">*</span>
        </Show>
      </label>
      {props.children}
      <Show when={props.help}>
        <p class="mt-1 text-[11px] text-fg-3">{props.help}</p>
      </Show>
    </div>
  );
}
