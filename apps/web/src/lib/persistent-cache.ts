/**
 * Persistent UI cache.
 *
 * The first paint after login was slow because we waited for: worker boot
 * → IndexedDB session restore → first /sync response. That's seconds.
 * This module is the fast-path that bypasses all of that.
 *
 * What lives here today:
 *   - `roomList` — single key with the last-known room summaries.
 *     Painted before the worker is even ready.
 *   - `roomTimeline:<roomId>` — last N decrypted events per opened
 *     room. Painted before `loadRoomHistory` round-trips.
 *
 * All entries are best-effort; live sync replaces them within a
 * second or two. A failed read/write never blocks the UI.
 */

import type { RoomSummary, TimelineEvent } from '@mata/shared/matrix';

const DB_NAME = 'mata-cache';
// Bumped from 1 → 2 to add the `timeline` store (separate from `kv`
// so cursor scans on timeline don't trip over unrelated keys).
const DB_VERSION = 2;
const STORE = 'kv';
const STORE_TIMELINE = 'timeline';
const KEY_ROOMS = 'roomList';

/** How many tail events we persist per opened room. Big enough that
 *  the first paint feels complete on a typical viewport, small enough
 *  that JSON.stringify + IDB write stays sub-millisecond. */
const TIMELINE_KEEP = 60;

/** Skip writes that fire faster than this. Sync can hand us a flood
 *  of updates per second; one snapshot every ~750ms is plenty for
 *  next-boot fidelity. */
const TIMELINE_WRITE_DEBOUNCE_MS = 750;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      // v2: dedicated store for per-room timeline snapshots so we
      // can iterate / clear them without touching the `kv` keyspace.
      if (!db.objectStoreNames.contains(STORE_TIMELINE)) {
        db.createObjectStore(STORE_TIMELINE);
      }
      // v2: also create `linkPreviews` here so whichever module wins
      // the open-race triggers the full schema. link-preview.tsx
      // mirrors the same idempotent creation, so both orderings work.
      if (!db.objectStoreNames.contains('linkPreviews')) {
        db.createObjectStore('linkPreviews');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error ?? new Error('idb tx failed'));
  });
}

export interface PersistedRoomList {
  rooms: RoomSummary[];
  savedAt: number;
}

export async function readRoomList(): Promise<PersistedRoomList | null> {
  try {
    const v = await tx<PersistedRoomList | undefined>('readonly', (s) => s.get(KEY_ROOMS));
    return v ?? null;
  } catch {
    return null;
  }
}

export async function writeRoomList(rooms: RoomSummary[]): Promise<void> {
  try {
    await tx('readwrite', (s) =>
      s.put({ rooms, savedAt: Date.now() } satisfies PersistedRoomList, KEY_ROOMS),
    );
  } catch {
    // swallow — cache is best-effort
  }
}

export async function clearRoomList(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(KEY_ROOMS));
  } catch {
    // ignore
  }
}

// ─── Per-room timeline snapshots ─────────────────────────────────────────

export interface PersistedTimeline {
  events: TimelineEvent[];
  prevToken: string | null;
  reachedStart: boolean;
  savedAt: number;
}

function timelineKey(roomId: string): string {
  return roomId;
}

async function timelineTx<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE_TIMELINE, mode);
    const s = t.objectStore(STORE_TIMELINE);
    const r = fn(s);
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error ?? new Error('idb timeline tx failed'));
  });
}

export async function readRoomTimeline(roomId: string): Promise<PersistedTimeline | null> {
  try {
    const v = await timelineTx<PersistedTimeline | undefined>('readonly', (s) =>
      s.get(timelineKey(roomId)),
    );
    return v ?? null;
  } catch {
    return null;
  }
}

const lastWriteAt: Map<string, number> = new Map();

/** Debounced write — only persists if it's been >750ms since the last
 *  write for this room. Sync floods us with updates; one snapshot per
 *  burst is plenty. */
export async function writeRoomTimeline(
  roomId: string,
  events: TimelineEvent[],
  prevToken: string | null,
  reachedStart: boolean,
): Promise<void> {
  const now = Date.now();
  const prev = lastWriteAt.get(roomId) ?? 0;
  if (now - prev < TIMELINE_WRITE_DEBOUNCE_MS) return;
  lastWriteAt.set(roomId, now);

  // Keep only the tail. The first paint is what matters; users
  // scrolling further back trigger `loadRoomHistory` anyway.
  const tail = events.length > TIMELINE_KEEP ? events.slice(-TIMELINE_KEEP) : events;
  try {
    await timelineTx('readwrite', (s) =>
      s.put(
        {
          events: tail,
          prevToken,
          reachedStart,
          savedAt: now,
        } satisfies PersistedTimeline,
        timelineKey(roomId),
      ),
    );
  } catch {
    // best-effort
  }
}

/** Drop all per-room timeline snapshots — used on logout so the next
 *  user can't see the previous user's plaintext events. */
export async function clearAllTimelines(): Promise<void> {
  try {
    await timelineTx('readwrite', (s) => s.clear());
    lastWriteAt.clear();
  } catch {
    // ignore
  }
}
