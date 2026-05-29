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

import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import type { RoomId, RoomSummary, UserId } from '@mata/shared/matrix';
import type { UserSearchHit } from '@mata/shared/rpc';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';
import { initials, prettyName } from './message-bubble.js';

type Mode = 'room' | 'dm';

export function NewRoomModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (roomId: RoomId) => void;
  /**
   * Room list, used to derive "frequent chats" (the user's DMs
   * sorted by lastActivityTs) for one-click adding into a new
   * group room. Pass null/undefined when no rooms loaded yet — the
   * quick-add row hides instead of flashing empty.
   */
  rooms: RoomSummary[] | null;
}) {
  const bridge = useBridge();
  const [mode, setMode] = createSignal<Mode>('dm');
  const [name, setName] = createSignal('');
  const [topic, setTopic] = createSignal('');
  const [encrypted, setEncrypted] = createSignal(true);
  const [submitting, setSubmitting] = createSignal(false);

  // ---- DM live user-directory search ----
  // The DM tab is "find a person to chat with", not "type the
  // canonical Matrix ID from memory". A live search hits the
  // homeserver's user_directory and shows hit cards as the user
  // types; clicking a hit locks the selection. Power users can
  // still paste a raw `@user:server` — when that pattern matches
  // we surface it as a synthetic hit at the top so the same flow
  // works whether you know the name or the ID.
  const [dmTerm, setDmTerm] = createSignal('');
  const [dmResults, setDmResults] = createSignal<UserSearchHit[]>([]);
  const [dmLimited, setDmLimited] = createSignal(false);
  const [dmSearching, setDmSearching] = createSignal(false);
  const [dmSelected, setDmSelected] = createSignal<UserSearchHit | null>(null);
  // Tracks the search generation so a slow response from an older
  // term doesn't overwrite results from a newer one.
  let dmSearchSeq = 0;

  const isFullMxid = (s: string): boolean => /^@[^:]+:.+/.test(s.trim());

  createEffect(
    on([dmTerm, mode], ([term, m]) => {
      if (m !== 'dm') return;
      // Clear selection if the user edited the search after picking.
      if (dmSelected() && term !== dmSelected()!.userId && term !== prettyName(dmSelected()!.userId)) {
        setDmSelected(null);
      }
      const trimmed = term.trim();
      if (trimmed.length < 2) {
        setDmResults([]);
        setDmLimited(false);
        setDmSearching(false);
        return;
      }
      const mySeq = ++dmSearchSeq;
      setDmSearching(true);
      // 200ms debounce — fast enough for the autocomplete feel,
      // slow enough that two-key bursts don't burn round-trips.
      const handle = setTimeout(async () => {
        try {
          const res = await bridge.request({ kind: 'searchUsers', term: trimmed, limit: 8 });
          if (mySeq !== dmSearchSeq) return; // stale, newer search took over
          setDmResults(res.results);
          setDmLimited(res.limited);
        } catch {
          if (mySeq !== dmSearchSeq) return;
          setDmResults([]);
          setDmLimited(false);
        } finally {
          if (mySeq === dmSearchSeq) setDmSearching(false);
        }
      }, 200);
      return () => clearTimeout(handle);
    }),
  );

  // ---- Room-mode multi-select invitees ----
  // Replaces the legacy comma-separated `invites` input. Power users
  // can still type a raw MXID and Enter to add it (kept as the
  // text input's submit behaviour below); most users go through the
  // quick-add row (recent DM partners) + the same live search the
  // DM tab uses.
  const [roomInvitees, setRoomInvitees] = createSignal<UserSearchHit[]>([]);
  const [roomTerm, setRoomTerm] = createSignal('');
  const [roomResults, setRoomResults] = createSignal<UserSearchHit[]>([]);
  const [roomLimited, setRoomLimited] = createSignal(false);
  const [roomSearching, setRoomSearching] = createSignal(false);
  let roomSearchSeq = 0;

  const addInvitee = (hit: UserSearchHit) => {
    setRoomInvitees((cur) => {
      if (cur.some((h) => h.userId === hit.userId)) return cur;
      return [...cur, hit];
    });
    setRoomTerm('');
    setRoomResults([]);
  };
  const removeInvitee = (userId: UserId) => {
    setRoomInvitees((cur) => cur.filter((h) => h.userId !== userId));
  };

  // Frequent chats: the user's existing DM rooms, sorted by recent
  // activity, mapped down to UserSearchHit shape so the existing
  // UserRow / chip components handle rendering. Excludes anyone
  // already in `roomInvitees` (so the chip "disappears" after pick,
  // making the empty slot feel intentional rather than stale).
  const frequentUsers = createMemo<UserSearchHit[]>(() => {
    const all = props.rooms ?? [];
    const dms = all
      .filter(
        (r) =>
          r.type === 'dm' &&
          r.membership === 'join' &&
          r.dmTargetUserId !== null,
      )
      .sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    const seen = new Set<string>();
    const picked = new Set(roomInvitees().map((h) => h.userId));
    const out: UserSearchHit[] = [];
    for (const r of dms) {
      const uid = r.dmTargetUserId as UserId;
      if (seen.has(uid) || picked.has(uid)) continue;
      seen.add(uid);
      out.push({
        userId: uid,
        // Use the room name as the display name for DMs — matrix-js-sdk
        // already resolves it to the counterparty's display name for
        // 2-person rooms, which is exactly what we want here.
        displayName: r.name && r.name !== uid ? r.name : null,
        avatarUrl: r.avatarUrl,
      } as UserSearchHit);
      if (out.length >= 8) break; // keep the chip strip a single row
    }
    return out;
  });

  // Live search for the room invitee picker. Mirrors the DM tab's
  // logic — same 200ms debounce, same stale-seq guard — but writes
  // into the room-mode signals so the two tabs don't fight each
  // other. The results list filters out anyone already added.
  createEffect(
    on([roomTerm, mode], ([term, m]) => {
      if (m !== 'room') return;
      const trimmed = term.trim();
      if (trimmed.length < 2) {
        setRoomResults([]);
        setRoomLimited(false);
        setRoomSearching(false);
        return;
      }
      const mySeq = ++roomSearchSeq;
      setRoomSearching(true);
      const handle = setTimeout(async () => {
        try {
          const res = await bridge.request({ kind: 'searchUsers', term: trimmed, limit: 8 });
          if (mySeq !== roomSearchSeq) return;
          const picked = new Set(roomInvitees().map((h) => h.userId));
          setRoomResults(res.results.filter((h) => !picked.has(h.userId)));
          setRoomLimited(res.limited);
        } catch {
          if (mySeq !== roomSearchSeq) return;
          setRoomResults([]);
          setRoomLimited(false);
        } finally {
          if (mySeq === roomSearchSeq) setRoomSearching(false);
        }
      }, 200);
      return () => clearTimeout(handle);
    }),
  );

  const reset = () => {
    setMode('dm');
    setName('');
    setTopic('');
    setEncrypted(true);
    setSubmitting(false);
    setDmTerm('');
    setDmResults([]);
    setDmSelected(null);
    setDmLimited(false);
    setDmSearching(false);
    dmSearchSeq++;
    setRoomInvitees([]);
    setRoomTerm('');
    setRoomResults([]);
    setRoomLimited(false);
    setRoomSearching(false);
    roomSearchSeq++;
  };

  const close = () => {
    if (submitting()) return;
    reset();
    props.onClose();
  };

  const validInvitee = (id: string): boolean => /^@[^:]+:.+/.test(id);

  const submit = async () => {
    if (submitting()) return;
    let inviteList: UserId[];
    if (mode() === 'dm') {
      // DM: prefer the explicitly picked search result. Fall back
      // to parsing the input as a raw Matrix ID so power users can
      // still paste `@alice:server` and hit Enter.
      const picked = dmSelected();
      if (picked) {
        inviteList = [picked.userId];
      } else {
        const typed = dmTerm().trim();
        if (!isFullMxid(typed)) {
          showToast('error', 'Pick a user from the list, or type a full Matrix ID.');
          return;
        }
        inviteList = [typed as UserId];
      }
    } else {
      // Selected chips are the source of truth. Anything sitting in
      // the search field as a raw MXID-looking string (user typed it
      // but didn't press Enter) gets folded in too — friendlier
      // than silently dropping it, while still rejecting partial
      // names that don't resolve.
      const chipIds = roomInvitees().map((h) => h.userId);
      const trailing = roomTerm().trim();
      if (trailing.length > 0) {
        if (isFullMxid(trailing) && !chipIds.includes(trailing as UserId)) {
          chipIds.push(trailing as UserId);
        } else if (trailing.length >= 2) {
          showToast(
            'error',
            'Pick a name from the list, or finish typing a full Matrix ID.',
          );
          return;
        }
      }
      const bad = chipIds.filter((u) => !validInvitee(u));
      if (bad.length > 0) {
        showToast('error', `Bad Matrix IDs: ${bad.join(', ')}`);
        return;
      }
      inviteList = chipIds;
      if (!name().trim()) {
        showToast('error', 'Room name is required.');
        return;
      }
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
    { id: 'dm', label: 'Find a person' },
    { id: 'room', label: 'New room' },
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

          <Show
            when={mode() === 'dm'}
            fallback={
              <Field
                label="Add people"
                help="Tap a recent chat below, or search by name. You can also paste a full Matrix ID."
              >
                {/* Picked invitees as removable chips. Renders an
                    empty placeholder row inline with the input so
                    the layout doesn't jump as chips appear. */}
                <Show when={roomInvitees().length > 0}>
                  <div class="mb-2 flex flex-wrap gap-1.5">
                    <For each={roomInvitees()}>
                      {(hit) => (
                        <span class="inline-flex items-center gap-1.5 rounded-full border border-mata-500/30 bg-mata-500/10 py-0.5 pl-0.5 pr-2 text-xs">
                          <UserAvatar hit={hit} size="xs" />
                          <span class="max-w-[140px] truncate">
                            {hit.displayName || prettyName(hit.userId)}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeInvitee(hit.userId)}
                            class="rounded-full p-0.5 text-fg-3 hover:bg-input hover:text-fg"
                            aria-label={`Remove ${hit.displayName || hit.userId}`}
                            title="Remove"
                          >
                            ✕
                          </button>
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                <div class="relative">
                  <input
                    type="text"
                    value={roomTerm()}
                    onInput={(e) => setRoomTerm(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      // Enter on a typed full MXID adds it as a chip
                      // without picking from results — keeps the
                      // power-user paste-and-go flow working.
                      if (e.key === 'Enter' && isFullMxid(roomTerm())) {
                        e.preventDefault();
                        addInvitee({
                          userId: roomTerm().trim() as UserId,
                        } as UserSearchHit);
                      } else if (
                        e.key === 'Backspace' &&
                        roomTerm() === '' &&
                        roomInvitees().length > 0
                      ) {
                        // Backspace on empty input pops the last
                        // chip — standard chip-input idiom.
                        const last = roomInvitees()[roomInvitees().length - 1];
                        removeInvitee(last.userId);
                      }
                    }}
                    placeholder="Search a name or paste a Matrix ID"
                    autocomplete="off"
                    class="w-full rounded-lg border border-line bg-elev px-3 py-2 pr-8 text-sm focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20"
                  />
                  <Show when={roomSearching()}>
                    <span
                      class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-fg-3"
                      aria-hidden="true"
                    >
                      …
                    </span>
                  </Show>
                </div>

                {/* Quick-add: frequent DM partners. Only visible
                    when nothing typed AND there are unpicked DMs
                    to surface. */}
                <Show
                  when={roomTerm().trim().length === 0 && frequentUsers().length > 0}
                >
                  <div class="mt-2">
                    <div class="mb-1 text-[10px] font-medium uppercase tracking-wider text-fg-3">
                      Recent chats
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={frequentUsers()}>
                        {(hit) => (
                          <button
                            type="button"
                            onClick={() => addInvitee(hit)}
                            class="inline-flex items-center gap-1.5 rounded-full border border-line bg-elev py-0.5 pl-0.5 pr-2 text-xs transition-colors hover:border-mata-500/40 hover:bg-mata-500/5"
                            title={hit.userId}
                          >
                            <UserAvatar hit={hit} size="xs" />
                            <span class="max-w-[140px] truncate">
                              {hit.displayName || prettyName(hit.userId)}
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Search-results dropdown. Only when actively
                    searching so the recent-chats row isn't pushed
                    around. */}
                <Show when={roomTerm().trim().length >= 2}>
                  <div class="mt-2 max-h-56 overflow-y-auto rounded-lg border border-line bg-base">
                    <Show
                      when={roomResults().length > 0}
                      fallback={
                        <Show
                          when={isFullMxid(roomTerm())}
                          fallback={
                            <div class="px-3 py-3 text-center text-xs text-fg-3">
                              {roomSearching() ? 'Searching…' : 'No matches.'}
                            </div>
                          }
                        >
                          <UserRow
                            hit={{ userId: roomTerm().trim() as UserId } as UserSearchHit}
                            onSelect={addInvitee}
                            hintLabel="Add"
                          />
                        </Show>
                      }
                    >
                      <ul class="divide-y" style={{ 'border-color': 'var(--color-line)' }}>
                        <For each={roomResults()}>
                          {(hit) => (
                            <li>
                              <UserRow hit={hit} onSelect={addInvitee} hintLabel="Add" />
                            </li>
                          )}
                        </For>
                        <Show when={roomLimited()}>
                          <li class="px-3 py-2 text-center text-[11px] text-fg-3">
                            More matches available — refine your search.
                          </li>
                        </Show>
                      </ul>
                    </Show>
                  </div>
                </Show>
              </Field>
            }
          >
            <Field
              label="Search by name or Matrix ID"
              help="Type a username (e.g. 'alice') to find people on your server. You can also paste a full Matrix ID."
              required
            >
              <div class="relative">
                <input
                  type="text"
                  value={dmTerm()}
                  onInput={(e) => setDmTerm(e.currentTarget.value)}
                  placeholder="alice  or  @alice:chat.greatass.me"
                  autocomplete="off"
                  autofocus
                  class="w-full rounded-lg border border-line bg-elev px-3 py-2 pr-8 text-sm focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20"
                />
                <Show when={dmSearching()}>
                  <span
                    class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-fg-3"
                    aria-hidden="true"
                  >
                    …
                  </span>
                </Show>
              </div>
            </Field>

            {/*
             * Results list. Three states:
             *   - selected user pinned at top (chip-style row)
             *   - hits returned → render rows
             *   - typed something that LOOKS like a full Matrix
             *     ID but no directory hit → render a synthetic
             *     fallback row so the user can still proceed.
             */}
            <Show
              when={dmSelected()}
              fallback={
                <div class="mb-4 max-h-56 overflow-y-auto rounded-lg border border-line bg-base">
                  <Show
                    when={dmResults().length > 0}
                    fallback={
                      <Show
                        when={isFullMxid(dmTerm()) && dmTerm().trim().length > 0}
                        fallback={
                          <div class="px-3 py-4 text-center text-xs text-fg-3">
                            {dmTerm().trim().length < 2
                              ? 'Start typing to search the directory.'
                              : dmSearching()
                                ? 'Searching…'
                                : 'No matches on the directory.'}
                          </div>
                        }
                      >
                        <UserRow
                          hit={{ userId: dmTerm().trim() as UserId }}
                          onSelect={(h) => {
                            setDmSelected(h);
                            setDmTerm(h.userId);
                          }}
                          hintLabel="Use this Matrix ID"
                        />
                      </Show>
                    }
                  >
                    <ul class="divide-y" style={{ 'border-color': 'var(--color-line)' }}>
                      <For each={dmResults()}>
                        {(hit) => (
                          <li>
                            <UserRow
                              hit={hit}
                              onSelect={(h) => {
                                setDmSelected(h);
                                setDmTerm(h.displayName || h.userId);
                              }}
                            />
                          </li>
                        )}
                      </For>
                      <Show when={dmLimited()}>
                        <li class="px-3 py-2 text-center text-[11px] text-fg-3">
                          More matches available — refine your search.
                        </li>
                      </Show>
                    </ul>
                  </Show>
                </div>
              }
            >
              {(sel) => (
                <div class="mb-4 flex items-center gap-3 rounded-lg border border-mata-500/30 bg-mata-500/5 px-3 py-2">
                  <UserAvatar hit={sel()} />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">
                      {sel().displayName || prettyName(sel().userId)}
                    </div>
                    <div class="truncate text-[11px] text-fg-3">{sel().userId}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setDmSelected(null);
                      setDmTerm('');
                    }}
                    class="rounded-md p-1 text-fg-3 hover:bg-input hover:text-fg"
                    aria-label="Clear selection"
                    title="Choose someone else"
                  >
                    ✕
                  </button>
                </div>
              )}
            </Show>
          </Show>

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
              {submitting()
                ? mode() === 'dm'
                  ? 'Starting…'
                  : 'Creating…'
                : mode() === 'dm'
                  ? 'Start chat'
                  : 'Create'}
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}

/**
 * Single user-directory result row. Hit the whole row for the
 * primary action — keep the avatar / name / id readable at
 * search-result density (28px avatar, two-line text right of it).
 */
function UserRow(props: {
  hit: UserSearchHit;
  onSelect: (hit: UserSearchHit) => void;
  hintLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.hit)}
      class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-input"
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
          {props.hintLabel}
        </span>
      </Show>
    </button>
  );
}

function UserAvatar(props: { hit: UserSearchHit; size?: 'sm' | 'xs' }) {
  // `xs` matches the chip strip; `sm` (default) matches the result
  // row density. Sizing decisions are kept in one place so chip
  // and row stay visually balanced.
  const sizeClass = () =>
    props.size === 'xs'
      ? 'h-5 w-5 text-[9px]'
      : 'h-8 w-8 text-[11px]';
  const imgSizeClass = () =>
    props.size === 'xs' ? 'h-5 w-5' : 'h-8 w-8';
  return (
    <Show
      when={props.hit.avatarUrl}
      fallback={
        <div
          class={`flex shrink-0 items-center justify-center rounded-full bg-input font-semibold text-fg-2 ${sizeClass()}`}
        >
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
          class={`shrink-0 rounded-full object-cover ${imgSizeClass()}`}
        />
      )}
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
