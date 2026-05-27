/**
 * Worker-owned session storage. See ADR-003.
 *
 * The main thread never reads or writes this. The crypto store is a
 * separate IDB database owned by matrix-sdk-crypto-wasm; we only handle
 * the access-token / device-id record here.
 */

import { type IDBPDatabase, openDB } from 'idb';
import type { DeviceId, UserId } from '@mata/shared/matrix';

const DB_NAME = 'mata/session';
const DB_VERSION = 1;
const STORE = 'accounts';

export interface SessionRecord {
  userId: UserId;
  deviceId: DeviceId;
  accessToken: string;
  refreshToken: string | null;
  homeserverBaseUrl: string;
  /** Reference to wrapped pickle key stored in the crypto DB. */
  pickleKeyRef: string;
  createdAt: number;
  lastSeenAt: number;
}

interface Schema {
  accounts: {
    key: UserId;
    value: SessionRecord;
  };
}

async function db(): Promise<IDBPDatabase<Schema>> {
  return openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'userId' });
      }
    },
  });
}

export async function saveSession(record: SessionRecord): Promise<void> {
  const d = await db();
  await d.put(STORE, record);
  d.close();
}

export async function loadActiveSession(): Promise<SessionRecord | null> {
  const d = await db();
  const all = await d.getAll(STORE);
  d.close();
  if (all.length === 0) return null;
  // For now we only support a single active account. Multi-account is a
  // future ADR. Return the most recently used record.
  return [...all].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0] ?? null;
}

export async function clearSession(userId: UserId): Promise<void> {
  const d = await db();
  await d.delete(STORE, userId);
  d.close();
}

export async function touchSession(userId: UserId): Promise<void> {
  const d = await db();
  const existing = await d.get(STORE, userId);
  if (existing) {
    existing.lastSeenAt = Date.now();
    await d.put(STORE, existing);
  }
  d.close();
}
