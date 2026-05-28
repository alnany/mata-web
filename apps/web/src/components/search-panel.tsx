// ============================================================================
// SearchPanel — slide-in right rail for room message search.
//
// Maps Cmd/Ctrl+F (and the header search button) to Synapse's
// `/_matrix/client/v3/search` via the worker's `searchMessages` RPC.
// Scope is the current room. We debounce the input by 300ms so each
// keystroke doesn't fire a request; an in-flight token guards against
// out-of-order responses (older request resolves after a newer one
// already updated state).
//
// Encrypted-room caveat: Synapse can't index ciphertext, so search in
// an E2EE room reliably returns zero hits. We render a one-line
// banner that explains this rather than presenting an empty list
// without context.
//
// Click-to-jump is a future pass — for v1 the panel is a read-only
// "where did we say X" surface. Each hit shows sender, timestamp,
// the matching line, and short before/after context strings.
// ============================================================================

import { For, Match, Show, Switch, createEffect, createSignal, on } from 'solid-js';
import type { RoomSummary, SearchHit } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { initials, prettyName } from './message-bubble.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'results'; hits: SearchHit[]; count: number; highlights: string[] };

export function SearchPanel(props: {
  room: RoomSummary;
  open: boolean;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const [query, setQuery] = createSignal('');
  const [phase, setPhase] = createSignal<Phase>({ kind: 'idle' });
  // Monotonic token: only the latest in-flight request is allowed to
  // commit its result to `phase`. Race-safe against quick typing.
  let token = 0;

  let inputRef: HTMLInputElement | undefined;

  // Auto-focus the input every time the panel opens, and reset state
  // when it closes so reopening starts clean. We deliberately do NOT
  // persist the query across open/close — search is transient.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setQuery('');
          setPhase({ kind: 'idle' });
          queueMicrotask(() => inputRef?.focus());
        }
      },
    ),
  );

  // Debounced search: 300ms after the user stops typing. createEffect
  // runs every time `query()` changes, schedules a timer, and cleans
  // up the previous one. An empty query resets to idle.
  createEffect(
    on(query, (q) => {
      const trimmed = q.trim();
      if (!trimmed) {
        setPhase({ kind: 'idle' });
        return;
      }
      const mine = ++token;
      setPhase({ kind: 'loading' });
      const handle = window.setTimeout(async () => {
        try {
          const res = await bridge.request({
            kind: 'searchMessages',
            query: trimmed,
            roomId: props.room.roomId,
          });
          if (mine !== token) return;
          setPhase({
            kind: 'results',
            hits: res.results,
            count: res.count,
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
            placeholder="Search this room…"
            class="w-full rounded-md border border-line bg-elev px-2.5 py-1.5 text-xs focus:border-mata-500 focus:bg-elev focus:outline-none focus:ring-2 focus:ring-mata-500/20 dark:focus:bg-neutral-900"
          />
          <Show when={props.room.isEncrypted}>
            <p class="mt-1.5 text-[10.5px] leading-snug text-fg-4">
              This room is end-to-end encrypted. The server can't index ciphertext, so search
              may return no results.
            </p>
          </Show>
        </div>

        <div class="flex-1 overflow-y-auto">
          <Switch>
            <Match when={phase().kind === 'idle'}>
              <EmptyState text="Type a word or phrase to search." />
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
                <Show
                  when={p().hits.length > 0}
                  fallback={<EmptyState text="No matches." />}
                >
                  <ul class="divide-y divide-line">
                    <For each={p().hits}>
                      {(hit) => <HitRow hit={hit} highlights={p().highlights} />}
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

function EmptyState(props: { text: string }) {
  return <p class="px-3 py-6 text-center text-[11.5px] text-fg-3">{props.text}</p>;
}

function HitRow(props: { hit: SearchHit; highlights: string[] }) {
  const ts = () =>
    new Date(props.hit.originServerTs).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  return (
    <li class="px-3 py-2.5 hover:bg-input">
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
