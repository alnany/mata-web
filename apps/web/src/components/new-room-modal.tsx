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

import { createEffect, createSignal, For, on, Show } from 'solid-js';
import type { RoomId, UserId } from '@mata/shared/matrix';
import type { UserSearchHit } from '@mata/shared/rpc';
import { useBridge } from '../bridge/context.js';
import { showToast } from '../stores/toast.js';
import { initials, prettyName } from './message-bubble.js';

type Mode = 'room' | 'dm';

export function NewRoomModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (roomId: RoomId) => void;
}) {
  const bridge = useBridge();
  const [mode, setMode] = createSignal<Mode>('dm');
  const [name, setName] = createSignal('');
  const [topic, setTopic] = createSignal('');
  const [invites, setInvites] = createSignal('');
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

  const reset = () => {
    setMode('dm');
    setName('');
    setTopic('');
    setInvites('');
    setEncrypted(true);
    setSubmitting(false);
    setDmTerm('');
    setDmResults([]);
    setDmSelected(null);
    setDmLimited(false);
    setDmSearching(false);
    dmSearchSeq++;
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
      inviteList = parseInvites(invites());
      const bad = inviteList.filter((u) => !validInvitee(u));
      if (bad.length > 0) {
        showToast('error', `Bad Matrix IDs: ${bad.join(', ')}`);
        return;
      }
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
                label="Invite (optional)"
                help="Comma-separated Matrix IDs to invite. You can also invite people later."
              >
                <input
                  type="text"
                  value={invites()}
                  onInput={(e) => setInvites(e.currentTarget.value)}
                  placeholder="@alice:chat.greatass.me"
                  autocomplete="off"
                  class="w-full rounded-lg border border-line bg-elev px-3 py-2 text-sm focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20"
                />
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
