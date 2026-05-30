// ============================================================================
// InviteUserModal — invite someone to an existing room.
//
// Two fast paths, mirroring NewRoomModal's person picker:
//   - "Recent chats" quick-select: the user's DM partners sorted by recent
//     activity, one tap to invite. This is the "oh, add Bob" moment most
//     invites actually are.
//   - Live directory search by display name, with a raw `@user:server`
//     paste fallback for power users / off-directory IDs.
//
// Reuses the existing `inviteToRoom` RPC. People already in the room
// (joined OR invited) are filtered out of both the quick row and the
// search results so you can't double-invite. On success we fire
// `onInvited` so the parent bumps its members resource.
// ============================================================================

import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import type { RoomId, RoomSummary, UserId } from '@mata/shared/matrix';
import type { UserSearchHit } from '@mata/shared/rpc';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';
import { initials, prettyName } from './message-bubble.js';

export function InviteUserModal(props: {
  open: boolean;
  roomId: RoomId;
  roomName: string;
  /** Room list, used to derive recent DM partners for quick-invite. */
  rooms?: RoomSummary[] | null;
  /** MXIDs already in the room (joined or invited) — filtered out. */
  existingMemberIds?: string[];
  /**
   * The signed-in user's own MXID — we lift the homeserver domain off
   * it so a bare username ("cyrano") auto-completes to a full MXID,
   * matching NewRoomModal. Most user directories don't index bare
   * localparts, so without this an invite-by-username dead-ends.
   */
  myUserId?: UserId | null;
  onClose: () => void;
  onInvited: () => void;
}) {
  const bridge = useBridge();
  const [term, setTerm] = createSignal('');
  const [results, setResults] = createSignal<UserSearchHit[]>([]);
  const [limited, setLimited] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  const [submitting, setSubmitting] = createSignal('');
  let inputRef: HTMLInputElement | undefined;
  let searchSeq = 0;

  const isFullMxid = (s: string): boolean => /^@[^:\s]+:[^\s]+$/.test(s.trim());

  const ownDomain = (): string | null => {
    const id = props.myUserId;
    if (!id) return null;
    const i = id.indexOf(':');
    return i > 0 ? id.slice(i + 1) : null;
  };

  // Resolve a typed value into a full MXID, completing a bare
  // localpart against our own homeserver. See NewRoomModal for the
  // accepted shapes. Null = not usable as an invite target.
  const resolveTypedId = (raw: string): UserId | null => {
    const t = raw.trim();
    if (!t || /\s/.test(t)) return null;
    if (isFullMxid(t)) return t as UserId;
    if (t.includes(':')) return null;
    const dom = ownDomain();
    if (!dom) return null;
    const lp = t.startsWith('@') ? t.slice(1) : t;
    return lp ? (`@${lp}:${dom}` as UserId) : null;
  };

  const reset = () => {
    setTerm('');
    setResults([]);
    setLimited(false);
    setSearching(false);
    setSubmitting('');
    searchSeq++;
  };

  const close = () => {
    if (submitting()) return;
    reset();
    props.onClose();
  };

  const excluded = createMemo(() => new Set(props.existingMemberIds ?? []));

  // Recent DM partners, sorted by activity, minus anyone already in the
  // room. Mapped to UserSearchHit shape so the row/avatar helpers render
  // them the same as directory results.
  const recentUsers = createMemo<UserSearchHit[]>(() => {
    const all = props.rooms ?? [];
    const skip = excluded();
    const dms = all
      .filter(
        (r) =>
          r.type === 'dm' &&
          r.membership === 'join' &&
          r.dmTargetUserId != null &&
          !skip.has(r.dmTargetUserId as string),
      )
      .sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    const seen = new Set<string>();
    const out: UserSearchHit[] = [];
    for (const r of dms) {
      const uid = r.dmTargetUserId as UserId;
      if (seen.has(uid)) continue;
      seen.add(uid);
      out.push({
        userId: uid,
        displayName: r.name && r.name !== uid ? r.name : null,
        avatarUrl: r.avatarUrl,
      } as UserSearchHit);
      if (out.length >= 8) break;
    }
    return out;
  });

  // Live directory search — 200ms debounce, stale-seq guard. Filters out
  // existing members so you never invite someone twice.
  createEffect(
    on([term, () => props.open], ([t, open]) => {
      if (!open) return;
      const trimmed = t.trim();
      if (trimmed.length < 2) {
        setResults([]);
        setLimited(false);
        setSearching(false);
        return;
      }
      const mySeq = ++searchSeq;
      setSearching(true);
      const handle = setTimeout(async () => {
        try {
          const res = await bridge.request({ kind: 'searchUsers', term: trimmed, limit: 8 });
          if (mySeq !== searchSeq) return;
          const skip = excluded();
          setResults(res.results.filter((h) => !skip.has(h.userId as string)));
          setLimited(res.limited);
        } catch {
          if (mySeq !== searchSeq) return;
          setResults([]);
          setLimited(false);
        } finally {
          if (mySeq === searchSeq) setSearching(false);
        }
      }, 200);
      return () => clearTimeout(handle);
    }),
  );

  const invite = async (rawId: string) => {
    const id = resolveTypedId(rawId) ?? '';
    if (submitting()) return;
    if (!id) {
      showToast('error', 'Pick someone from the list, or type a username / full Matrix ID.');
      inputRef?.focus();
      return;
    }
    if (excluded().has(id)) {
      showToast('error', 'They are already in this room.');
      return;
    }
    setSubmitting(id);
    try {
      await bridge.request({
        kind: 'inviteToRoom',
        roomId: props.roomId,
        userId: id as UserId,
      });
      showToast('success', `Invited ${prettyName(id as UserId)}`);
      props.onInvited();
      reset();
      props.onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `Invite failed: ${msg}`);
      setSubmitting('');
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
          ref={() => queueMicrotask(() => inputRef?.focus())}
        >
          <div class="mb-4">
            <h2 class="text-base font-semibold">Invite to room</h2>
            <p class="mt-0.5 truncate text-[11.5px] text-fg-3">{props.roomName}</p>
          </div>

          <label class="block text-[11.5px] font-medium text-fg-2">
            Search a name or paste a Matrix ID
          </label>
          <div class="relative mt-1">
            <input
              ref={inputRef}
              type="text"
              value={term()}
              onInput={(e) => setTerm(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && resolveTypedId(term())) {
                  e.preventDefault();
                  void invite(term());
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  close();
                }
              }}
              placeholder="alice  or  @alice:example.org"
              autocomplete="off"
              class="w-full rounded-md border border-line bg-elev px-2.5 py-1.5 pr-8 text-sm focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20"
              disabled={!!submitting()}
            />
            <Show when={searching()}>
              <span
                class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-fg-3"
                aria-hidden="true"
              >
                …
              </span>
            </Show>
          </div>

          {/* Recent chats quick-invite — only when nothing typed. */}
          <Show when={term().trim().length === 0 && recentUsers().length > 0}>
            <div class="mt-3">
              <div class="mb-1 text-[10px] font-medium uppercase tracking-wider text-fg-3">
                Recent chats
              </div>
              <div class="max-h-56 overflow-y-auto rounded-lg border border-line bg-base">
                <ul class="divide-y" style={{ 'border-color': 'var(--color-line)' }}>
                  <For each={recentUsers()}>
                    {(hit) => (
                      <li>
                        <UserRow
                          hit={hit}
                          busy={submitting() === hit.userId}
                          onSelect={() => void invite(hit.userId)}
                          hintLabel="Invite"
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </div>
          </Show>

          {/* Search results. */}
          <Show when={term().trim().length >= 2}>
            <div class="mt-3 max-h-56 overflow-y-auto rounded-lg border border-line bg-base">
              <Show
                when={results().length > 0}
                fallback={
                  <Show
                    when={resolveTypedId(term())}
                    fallback={
                      <div class="px-3 py-3 text-center text-xs text-fg-3">
                        {searching() ? 'Searching…' : 'No directory match — type a username to invite directly.'}
                      </div>
                    }
                  >
                    {(id) => (
                      <UserRow
                        hit={{ userId: id() } as UserSearchHit}
                        busy={submitting() === id()}
                        onSelect={() => void invite(term())}
                        hintLabel={isFullMxid(term()) ? 'Invite this ID' : 'Invite'}
                      />
                    )}
                  </Show>
                }
              >
                <ul class="divide-y" style={{ 'border-color': 'var(--color-line)' }}>
                  <For each={results()}>
                    {(hit) => (
                      <li>
                        <UserRow
                          hit={hit}
                          busy={submitting() === hit.userId}
                          onSelect={() => void invite(hit.userId)}
                          hintLabel="Invite"
                        />
                      </li>
                    )}
                  </For>
                  <Show when={limited()}>
                    <li class="px-3 py-2 text-center text-[11px] text-fg-3">
                      More matches available — refine your search.
                    </li>
                  </Show>
                </ul>
              </Show>
            </div>
          </Show>

          <div class="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              disabled={!!submitting()}
              class="rounded-md px-3 py-1.5 text-sm text-fg-2 hover:bg-input disabled:opacity-50"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

function UserRow(props: {
  hit: UserSearchHit;
  onSelect: () => void;
  busy?: boolean;
  hintLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      disabled={props.busy}
      class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-input disabled:opacity-60"
    >
      <UserAvatar hit={props.hit} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">
          {props.hit.displayName || prettyName(props.hit.userId)}
        </div>
        <div class="truncate text-[11px] text-fg-3">{props.hit.userId}</div>
      </div>
      <Show when={props.hintLabel}>
        <span class="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-fg-3">
          {props.busy ? 'Inviting…' : props.hintLabel}
        </span>
      </Show>
    </button>
  );
}

function UserAvatar(props: { hit: UserSearchHit }) {
  return (
    <Show
      when={props.hit.avatarUrl}
      fallback={
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-input text-[11px] font-semibold text-fg-2">
          {initials(prettyName(props.hit.userId))}
        </div>
      }
    >
      {(url) => (
        <img
          src={url()}
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          class="h-8 w-8 shrink-0 rounded-full object-cover"
        />
      )}
    </Show>
  );
}
