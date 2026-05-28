// ============================================================================
// InviteUserModal — invite a single Matrix ID to an existing room.
//
// Triggered from the MembersPanel header. Reuses the existing
// `inviteToRoom` RPC (already wired through bridge.ts → sdk-impl).
// We deliberately keep it single-shot rather than the comma-list shape
// of NewRoomModal: invites in an existing room are usually a "oh, add
// Bob" moment, not a batch operation. For batch we'd reopen the modal.
//
// On success we fire `onInvited` so the parent can bump its members
// resource and the new invitee appears in the panel under "Invited"
// without waiting on the next sync delta.
// ============================================================================

import { createSignal, Show } from 'solid-js';
import type { RoomId, UserId } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';

export function InviteUserModal(props: {
  open: boolean;
  roomId: RoomId;
  roomName: string;
  onClose: () => void;
  onInvited: () => void;
}) {
  const bridge = useBridge();
  const [userId, setUserId] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);

  let inputRef: HTMLInputElement | undefined;

  const reset = () => {
    setUserId('');
    setSubmitting(false);
  };

  const close = () => {
    if (submitting()) return;
    reset();
    props.onClose();
  };

  // Matches `@local:server.tld` — the same shape NewRoomModal accepts.
  // Server-side will reject IDs the homeserver can't resolve; this is
  // just a fast-fail for obvious typos before the round-trip.
  const valid = (id: string): boolean => /^@[^:\s]+:[^\s]+$/.test(id);

  const submit = async () => {
    if (submitting()) return;
    const id = userId().trim();
    if (!valid(id)) {
      showToast('error', 'Use a full Matrix ID like @alice:example.org');
      inputRef?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await bridge.request({
        kind: 'inviteToRoom',
        roomId: props.roomId,
        userId: id as UserId,
      });
      showToast('success', `Invited ${id}`);
      props.onInvited();
      reset();
      props.onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `Invite failed: ${msg}`);
      setSubmitting(false);
    }
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
        onClick={close}
      >
        <div
          class="w-full max-w-sm rounded-xl border border-line bg-elev p-5 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          ref={(el) => queueMicrotask(() => inputRef?.focus()) as unknown as void & typeof el}
        >
          <div class="mb-4">
            <h2 class="text-base font-semibold">Invite to room</h2>
            <p class="mt-0.5 truncate text-[11.5px] text-fg-3">{props.roomName}</p>
          </div>

          <label class="block text-[11.5px] font-medium text-fg-2">Matrix ID</label>
          <input
            ref={inputRef}
            type="text"
            value={userId()}
            onInput={(e) => setUserId(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
            placeholder="@alice:example.org"
            class="mt-1 w-full rounded-md border border-line bg-elev px-2.5 py-1.5 text-sm focus:border-mata-500 focus:bg-elev focus:outline-none focus:ring-2 focus:ring-mata-500/20 dark:focus:bg-neutral-900"
            disabled={submitting()}
          />
          <p class="mt-1.5 text-[10.5px] text-fg-4">
            Full Matrix ID — local part plus the homeserver, separated by a colon.
          </p>

          <div class="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              disabled={submitting()}
              class="rounded-md px-3 py-1.5 text-sm text-fg-2 hover:bg-input disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting() || userId().trim().length === 0}
              class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink transition-[filter] hover:brightness-95 disabled:opacity-50"
            >
              {submitting() ? 'Inviting…' : 'Invite'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
