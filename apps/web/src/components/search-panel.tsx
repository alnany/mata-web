// ============================================================================
// SearchPanel — slide-in right rail for message search.
//
// Two scopes, toggled at the top of the panel:
//   - "This room": Synapse `/_matrix/client/v3/search` scoped to the
//     current room (local timeline scan for E2EE rooms, since the server
//     can't index ciphertext).
//   - "All chats": global search across every joined room. The worker
//     merges the server result with a local scan of all rooms' decrypted
//     timelines, so encrypted content still surfaces. Each hit shows the
//     room it came from, and selecting it jumps to that room + message.
//
// We debounce input by 300ms; an in-flight token guards against
// out-of-order responses. Selecting a hit jumps to the message (and
// switches rooms first when the hit is in a different room) — we don't
// auto-close so users can keep scanning the next hit.
// ============================================================================

import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { EventId, RoomId, RoomSummary, SearchHit } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { initials, prettyName } from './message-bubble.js';

type Scope = 'room' | 'all';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  // Filters were typed with no free-text term — we can't query the index
  // on filters alone, so prompt for a word to combine them with.
  | { kind: 'needTerm' }
  | { kind: 'results'; hits: SearchHit[]; count: number; highlights: string[] };

// `has:` filter → the msgtypes that satisfy it.
const HAS_MSGTYPES: Record<string, string[]> = {
  image: ['m.image'],
  file: ['m.file'],
  video: ['m.video'],
  audio: ['m.audio'],
  voice: ['m.audio'],
};

const URL_RE = /https?:\/\/|www\./i;

type ParsedQuery = {
  /** Free-text remainder sent to the search index. */
  term: string;
  /** `from:` value, lowercased — matched against sender id + display name. */
  from: string | null;
  /** `has:` tokens (link/image/file/video/audio). */
  has: string[];
};

// Pull `from:` and `has:` operators out of the raw query, Gmail/Telegram
// style. Everything that isn't an operator becomes the free-text term.
//   "deploy from:alice has:link"  →  { term: "deploy", from: "alice", has: ["link"] }
function parseQuery(raw: string): ParsedQuery {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let from: string | null = null;
  const has: string[] = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (low.startsWith('from:') && tok.length > 5) {
      from = low.slice(5);
    } else if (low.startsWith('has:') && tok.length > 4) {
      const v = low.slice(4);
      if (v === 'link' || v in HAS_MSGTYPES) has.push(v);
    } else {
      rest.push(tok);
    }
  }
  return { term: rest.join(' '), from, has };
}

// Apply parsed `from:`/`has:` filters to the index hits client-side. The
// index only matches text, so operators refine the returned set.
function applyFilters(hits: SearchHit[], q: ParsedQuery): SearchHit[] {
  return hits.filter((h) => {
    if (q.from) {
      const sender = h.sender.toLowerCase();
      const name = prettyName(h.sender).toLowerCase();
      if (!sender.includes(q.from) && !name.includes(q.from)) return false;
    }
    for (const f of q.has) {
      if (f === 'link') {
        if (!URL_RE.test(h.body)) return false;
      } else {
        const types = HAS_MSGTYPES[f] ?? [];
        if (!types.includes(h.msgtype)) return false;
      }
    }
    return true;
  });
}

export function SearchPanel(props: {
  room: RoomSummary;
  open: boolean;
  /** All joined rooms — used to label cross-room hits in "All chats". */
  rooms?: RoomSummary[] | null;
  onClose: () => void;
  // Click handler when the user picks a hit. The room view wires this to
  // its jump scroller for same-room hits, and to a room-switch + jump for
  // cross-room hits (global scope). Panel stays open so the user can keep
  // scanning.
  onSelect?: (roomId: RoomId, eventId: EventId) => void;
}) {
  const bridge = useBridge();
  const [query, setQuery] = createSignal('');
  const [scope, setScope] = createSignal<Scope>('room');
  const [phase, setPhase] = createSignal<Phase>({ kind: 'idle' });
  // Monotonic token: only the latest in-flight request is allowed to
  // commit its result to `phase`. Race-safe against quick typing.
  let token = 0;

  let inputRef: HTMLInputElement | undefined;

  // Jump-to-date: resolve the first message at/after the picked day in the
  // CURRENT room (the homeserver's timestamp_to_event, or a live-timeline
  // scan), then hand off to the room view's jump scroller. Always scoped to
  // the open room — "jump" is inherently a single-conversation action.
  const [jumpBusy, setJumpBusy] = createSignal(false);
  const jumpToDate = async (value: string) => {
    if (!value || jumpBusy()) return;
    // <input type=date> gives YYYY-MM-DD; interpret as local midnight.
    const ts = new Date(`${value}T00:00:00`).getTime();
    if (Number.isNaN(ts)) return;
    setJumpBusy(true);
    try {
      const res = await bridge.request({
        kind: 'jumpToTimestamp',
        roomId: props.room.roomId,
        ts,
      });
      if (res.kind === 'jumpToTimestamp' && res.eventId) {
        props.onSelect?.(props.room.roomId, res.eventId);
      } else {
        setPhase({ kind: 'error', message: 'No messages on or after that date.' });
      }
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Jump failed',
      });
    } finally {
      setJumpBusy(false);
    }
  };

  // roomId -> display name, for labeling cross-room hits.
  const roomNames = createMemo(() => {
    const m = new Map<string, string>();
    for (const r of props.rooms ?? []) m.set(r.roomId, r.name || r.roomId);
    return m;
  });

  // Auto-focus the input every time the panel opens, and reset state when
  // it closes so reopening starts clean. Scope resets to the current room.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setQuery('');
          setScope('room');
          setPhase({ kind: 'idle' });
          queueMicrotask(() => inputRef?.focus());
        }
      },
    ),
  );

  // Debounced search: 300ms after the user stops typing. Re-runs when the
  // query OR the scope changes. An empty query resets to idle.
  createEffect(
    on([query, scope], ([q, sc]) => {
      const trimmed = q.trim();
      if (!trimmed) {
        setPhase({ kind: 'idle' });
        return;
      }
      const parsed = parseQuery(trimmed);
      // Filters typed but no word to anchor them — the text index needs a
      // term to run against, so ask for one instead of returning nothing.
      if (!parsed.term && (parsed.from || parsed.has.length > 0)) {
        setPhase({ kind: 'needTerm' });
        return;
      }
      const mine = ++token;
      setPhase({ kind: 'loading' });
      const handle = window.setTimeout(async () => {
        try {
          const res = await bridge.request({
            kind: 'searchMessages',
            query: parsed.term,
            roomId: sc === 'all' ? null : props.room.roomId,
          });
          if (mine !== token) return;
          const filtered = applyFilters(res.results, parsed);
          setPhase({
            kind: 'results',
            hits: filtered,
            count: filtered.length,
            highlights: res.highlights,
          });
        } catch (err) {
          if (mine !== token) return;
          setPhase({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Search failed',
          });
        }
      }, 300);
      return () => window.clearTimeout(handle);
    }),
  );

  return (
    <Show when={props.open}>
      <aside
        class="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-line bg-elev shadow-xl"
        aria-label="Search panel"
      >
        <header class="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <span class="text-sm font-semibold">Search</span>
          <Show
            when={(() => {
              const p = phase();
              return p.kind === 'results' ? p : null;
            })()}
          >
            {(p) => <span class="text-[11px] text-fg-3">{p().count}</span>}
          </Show>
          <button
            type="button"
            onClick={props.onClose}
            class="ml-auto rounded p-1 text-fg-3 hover:bg-input hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {/* Scope toggle */}
        <div class="flex gap-1 border-b border-line px-3 py-2">
          <ScopeTab label="This room" active={scope() === 'room'} onClick={() => setScope('room')} />
          <ScopeTab label="All chats" active={scope() === 'all'} onClick={() => setScope('all')} />
        </div>

        <div class="border-b border-line px-3 py-2">
          <input
            ref={inputRef}
            type="text"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                props.onClose();
              }
            }}
            placeholder={scope() === 'all' ? 'Search all chats…' : 'Search this room…'}
            class="w-full rounded-md border border-line bg-elev px-2.5 py-1.5 text-xs focus:border-mata-500 focus:bg-elev focus:outline-none focus:ring-2 focus:ring-mata-500/20 dark:focus:bg-neutral-900"
          />
          <Show when={scope() === 'all'}>
            <p class="mt-1.5 text-[10.5px] leading-snug text-fg-4">
              Searching across all your chats. Encrypted rooms are matched against history
              already loaded on this device — open a room and scroll up to widen its window.
            </p>
          </Show>
          <Show when={scope() === 'room' && props.room.isEncrypted}>
            <p class="mt-1.5 text-[10.5px] leading-snug text-fg-4">
              Encrypted room — searching messages already loaded on this device. Scroll up to
              load more history into the search window.
            </p>
          </Show>
          {/* Filter syntax hint — Gmail/Telegram-style operators. */}
          <p class="mt-1.5 text-[10px] leading-snug text-fg-4">
            Filter with{' '}
            <code class="rounded bg-input px-1 py-px font-mono text-[9.5px]">from:name</code>,{' '}
            <code class="rounded bg-input px-1 py-px font-mono text-[9.5px]">has:link</code>,{' '}
            <code class="rounded bg-input px-1 py-px font-mono text-[9.5px]">has:image</code>,{' '}
            <code class="rounded bg-input px-1 py-px font-mono text-[9.5px]">has:file</code>
          </p>
        </div>

        {/* Jump to date — scoped to the current room. */}
        <div class="flex items-center gap-2 border-b border-line px-3 py-2">
          <span class="text-[11px] font-medium text-fg-3">Jump to date</span>
          <input
            type="date"
            disabled={jumpBusy()}
            onChange={(e) => void jumpToDate(e.currentTarget.value)}
            class="ml-auto rounded-md border border-line bg-elev px-2 py-1 text-[11px] text-fg-2 focus:border-mata-500 focus:outline-none focus:ring-2 focus:ring-mata-500/20 disabled:opacity-50 dark:focus:bg-neutral-900"
            aria-label="Jump to date in this room"
          />
        </div>

        <div class="flex-1 overflow-y-auto">
          <Switch>
            <Match when={phase().kind === 'idle'}>
              <EmptyState
                text={
                  scope() === 'all'
                    ? 'Type to search across all chats.'
                    : 'Type a word or phrase to search.'
                }
              />
            </Match>
            <Match when={phase().kind === 'needTerm'}>
              <EmptyState text="Add a word to combine with your filters." />
            </Match>
            <Match when={phase().kind === 'loading'}>
              <EmptyState text="Searching…" />
            </Match>
            <Match
              when={(() => {
                const p = phase();
                return p.kind === 'error' ? p : null;
              })()}
            >
              {(p) => <EmptyState text={`Search failed: ${p().message}`} />}
            </Match>
            <Match
              when={(() => {
                const p = phase();
                return p.kind === 'results' ? p : null;
              })()}
            >
              {(p) => (
                <Show when={p().hits.length > 0} fallback={<EmptyState text="No matches." />}>
                  <ul class="divide-y divide-line">
                    <For each={p().hits}>
                      {(hit) => (
                        <HitRow
                          hit={hit}
                          highlights={p().highlights}
                          roomLabel={
                            scope() === 'all' && hit.roomId !== props.room.roomId
                              ? roomNames().get(hit.roomId) ?? prettyName(hit.roomId as never)
                              : null
                          }
                          onSelect={props.onSelect}
                        />
                      )}
                    </For>
                  </ul>
                </Show>
              )}
            </Match>
          </Switch>
        </div>
      </aside>
    </Show>
  );
}

function ScopeTab(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors"
      classList={{
        'bg-input text-fg': props.active,
        'text-fg-3 hover:bg-input/60 hover:text-fg-2': !props.active,
      }}
    >
      {props.label}
    </button>
  );
}

function EmptyState(props: { text: string }) {
  return <p class="px-3 py-6 text-center text-[11.5px] text-fg-3">{props.text}</p>;
}

function HitRow(props: {
  hit: SearchHit;
  highlights: string[];
  /** Non-null in global scope when the hit is in another room. */
  roomLabel: string | null;
  onSelect?: (roomId: RoomId, eventId: EventId) => void;
}) {
  const ts = () =>
    new Date(props.hit.originServerTs).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onSelect?.(props.hit.roomId, props.hit.eventId)}
        class="block w-full cursor-pointer px-3 py-2.5 text-left hover:bg-input focus:bg-input focus:outline-none"
      >
        <Show when={props.roomLabel}>
          {(label) => (
            <div class="mb-1 inline-flex max-w-full items-center gap-1 rounded-full bg-input px-2 py-0.5 text-[10px] font-medium text-fg-3">
              <span class="truncate">{label()}</span>
            </div>
          )}
        </Show>
        <div class="flex items-center gap-2">
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-input text-[9px] font-semibold text-fg-2"
            aria-hidden="true"
          >
            {initials(props.hit.sender)}
          </span>
          <span class="truncate text-[11.5px] font-medium text-fg">
            {prettyName(props.hit.sender)}
          </span>
          <span class="ml-auto shrink-0 text-[10px] text-fg-4">{ts()}</span>
        </div>
        <Show when={props.hit.contextBefore}>
          <p class="mt-1.5 truncate text-[10.5px] text-fg-4">{props.hit.contextBefore}</p>
        </Show>
        <p class="mt-0.5 line-clamp-3 text-[12px] leading-snug text-fg-2">
          <Highlighted text={props.hit.body} terms={props.highlights} />
        </p>
        <Show when={props.hit.contextAfter}>
          <p class="mt-0.5 truncate text-[10.5px] text-fg-4">{props.hit.contextAfter}</p>
        </Show>
      </button>
    </li>
  );
}

// Highlight the server-supplied stem terms inside the body. We render
// each match as a non-bold `<mark>` so the visual weight stays on the
// content; the highlight token is muted-yellow under both themes.
function Highlighted(props: { text: string; terms: string[] }) {
  const segments = () => {
    const terms = props.terms.filter((t) => t.length > 0);
    if (terms.length === 0) return [{ text: props.text, hit: false }];
    // Escape regex metachars in each stem term, then OR-join.
    const pattern = new RegExp(
      `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
      'ig',
    );
    const parts: { text: string; hit: boolean }[] = [];
    let lastIdx = 0;
    for (const m of props.text.matchAll(pattern)) {
      const idx = m.index ?? 0;
      if (idx > lastIdx) parts.push({ text: props.text.slice(lastIdx, idx), hit: false });
      parts.push({ text: m[0], hit: true });
      lastIdx = idx + m[0].length;
    }
    if (lastIdx < props.text.length) parts.push({ text: props.text.slice(lastIdx), hit: false });
    return parts;
  };
  return (
    <For each={segments()}>
      {(seg) =>
        seg.hit ? (
          <mark class="rounded-[2px] bg-yellow-200/60 px-[1px] text-fg dark:bg-yellow-500/30">
            {seg.text}
          </mark>
        ) : (
          <>{seg.text}</>
        )
      }
    </For>
  );
}
