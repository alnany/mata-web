/**
 * Global presence store — online status + "last seen" for any user.
 *
 * The worker forwards every m.presence ephemeral as a `presence`
 * WorkerEvent (see sdk-impl `emitPresence`). We latch the freshest
 * snapshot per user here and expose:
 *   - `mountPresence(bridge)` — subscribe once at app start (home.tsx).
 *   - `ensurePresence(bridge, userId)` — lazily seed a user we haven't
 *     seen a live event for yet (DM peer / member row), via a one-shot
 *     `/presence/{userId}/status` fetch.
 *   - `presenceOf(userId)` — reactive accessor.
 *   - `lastSeenLabel(entry)` — human "online" / "last seen 5m ago".
 *
 * `lastActiveAgo` is the ms-since-active AT THE MOMENT THE EVENT ARRIVED,
 * so we store `receivedAt` and add the elapsed wall-clock time when
 * rendering — otherwise "last seen" would freeze at its arrival value.
 */
import { createStore } from 'solid-js/store';
import type { MatrixBridge } from '@mata/shared/rpc';
import type { UserId } from '@mata/shared/matrix';

export interface PresenceEntry {
  presence: 'online' | 'offline' | 'unavailable';
  lastActiveAgoMs: number | null;
  currentlyActive: boolean | null;
  receivedAt: number;
}

const [store, setStore] = createStore<Record<string, PresenceEntry>>({});

/** Reactive read. Returns undefined until we have any data for the user. */
export function presenceOf(userId: string): PresenceEntry | undefined {
  return store[userId];
}

/** True when the user is actively online right now. */
export function isOnline(entry: PresenceEntry | undefined): boolean {
  if (!entry) return false;
  return entry.presence === 'online' && entry.currentlyActive !== false;
}

function relTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 5) return `${w}w ago`;
  return 'a long time ago';
}

/** Header / profile subtitle: "online", "last seen 5m ago", "away", "offline". */
export function lastSeenLabel(entry: PresenceEntry | undefined): string {
  if (!entry) return '';
  if (isOnline(entry)) return 'online';
  if (entry.lastActiveAgoMs != null) {
    const elapsed = entry.lastActiveAgoMs + (Date.now() - entry.receivedAt);
    return `last seen ${relTime(elapsed)}`;
  }
  if (entry.presence === 'unavailable') return 'away';
  return 'offline';
}

function put(
  userId: string,
  p: { presence: 'online' | 'offline' | 'unavailable'; lastActiveAgoMs: number | null; currentlyActive: boolean | null },
): void {
  setStore(userId, { ...p, receivedAt: Date.now() });
}

/**
 * Subscribe to live presence events. Call once; returns an unsubscribe
 * fn suitable for `onCleanup`.
 */
export function mountPresence(bridge: MatrixBridge): () => void {
  return bridge.on('presence', (e) => {
    put(e.userId, {
      presence: e.presence,
      lastActiveAgoMs: e.lastActiveAgoMs,
      currentlyActive: e.currentlyActive,
    });
  });
}

const inflight = new Set<string>();

/**
 * Lazily seed presence for a user we don't have yet (no live event seen).
 * Safe to call repeatedly — it no-ops once data exists or a fetch is
 * already in flight. Degrades silently if the server has presence off.
 */
export function ensurePresence(bridge: MatrixBridge, userId: UserId): void {
  if (store[userId] || inflight.has(userId)) return;
  inflight.add(userId);
  void bridge
    .request({ kind: 'fetchPresence', userId })
    .then((res) => {
      if (res.kind === 'fetchPresence') {
        put(userId, {
          presence: res.presence,
          lastActiveAgoMs: res.lastActiveAgoMs,
          currentlyActive: res.currentlyActive,
        });
      }
    })
    .catch(() => {
      /* presence may be disabled server-side — stay silent, dot = offline */
    })
    .finally(() => inflight.delete(userId));
}
