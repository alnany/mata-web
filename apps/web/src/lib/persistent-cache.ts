/**
 * Persistent room-list cache.
 *
 * The first paint after login was slow because we waited for: worker boot
 * → IndexedDB session restore → first /sync response. That's seconds.
 *
 * On every successful `loadRoomList` or `syncUpdate`, we snapshot the
 * current room list into IndexedDB on the main thread. On next boot,
 * `read()` returns the snapshot synchronously (well — as fast as IDB lets
 * us), so we can paint a believable UI before the worker is ready.
 *
 * Stale data is fine: live sync replaces it within a second or two.
 */

import type { RoomSummary } from '@mata/shared/matrix';

const DB_NAME = 'mata-cache';
const DB_VERSION = 1;
const STORE = 'kv';
const KEY_ROOMS = 'roomList';

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
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
