/**
 * Worker-owned session storage. See ADR-003 and ADR-009.
 *
 * The main thread never reads or writes this. The crypto store is a
 * separate IDB database owned by matrix-sdk-crypto-wasm; we only handle
 * the access-token / device-id record here.
 *
 * Schema v2 (ADR-009 multi-account): `displayName` and `avatarUrl` are
 * cached per record so the workspace rail can paint inactive accounts
 * without booting their MatrixClient. Both are nullable — older records
 * written under schema v1 simply round-trip as undefined.
 */

import { type IDBPDatabase, openDB } from 'idb';
import type { DeviceId, MxcUri, UserId } from '@mata/shared/matrix';

const DB_NAME = 'mata/session';
const DB_VERSION = 2;
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
  /** Cached profile bits — written by sdk-impl after each client boot. */
  displayName?: string | null;
  avatarUrl?: MxcUri | null;
}

interface Schema {
  accounts: {
    key: UserId;
    value: SessionRecord;
  };
}

async function db(): Promise<IDBPDatabase<Schema>> {
  return openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'userId' });
      }
      // v2: no schema change; existing records gain optional fields
      // that read as `undefined` until next saveSession.
      if (oldVersion < 2) {
        /* no-op upgrade */
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
  // "Active" = most recently used. Multi-account UI may later override
  // by passing an explicit userId to loadSession() below.
  return [...all].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0] ?? null;
}

export async function loadSession(userId: UserId): Promise<SessionRecord | null> {
  const d = await db();
  const r = await d.get(STORE, userId);
  d.close();
  return r ?? null;
}

export async function listAllSessions(): Promise<SessionRecord[]> {
  const d = await db();
  const all = await d.getAll(STORE);
  d.close();
  return [...all].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
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

export async function updateSessionProfile(
  userId: UserId,
  profile: { displayName: string | null; avatarUrl: MxcUri | null },
): Promise<void> {
  const d = await db();
  const existing = await d.get(STORE, userId);
  if (existing) {
    existing.displayName = profile.displayName;
    existing.avatarUrl = profile.avatarUrl;
    await d.put(STORE, existing);
  }
  d.close();
}
