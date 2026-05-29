/**
 * IndexedDB-backed media cache for `mxc://` blobs.
 *
 * Why this exists:
 *   - `loadMedia()` re-fetches ciphertext from the homeserver and
 *     re-runs AES-CTR every time the same image scrolls into view.
 *     Encrypted-media decode is the most CPU we burn per render.
 *   - Browser HTTP cache can't help: the GET carries `Authorization`,
 *     so most caches refuse to share it across navigations / tabs,
 *     and many homeservers omit `Cache-Control` on media routes.
 *   - mxc URIs are content-addressed by spec — same URI ⇒ same bytes
 *     forever. Caching plaintext by URI is safe and never needs
 *     invalidation.
 *
 * Strategy:
 *   - One IDB database (`mata-media-cache`), one store (`blobs`),
 *     keyed by mxc URI. Value carries the decrypted bytes, the MIME
 *     hint the caller will need, the byte size, and the last-access
 *     timestamp for LRU.
 *   - A `meta` store carries the running total size so we don't
 *     have to scan the whole index on every write.
 *   - On write, if total > `MAX_BYTES`, evict LRU entries until under
 *     the soft cap. Eviction runs async — never blocks the caller.
 *   - All errors are swallowed: a broken cache must never break the
 *     app, since `loadMedia` has a perfectly good network fallback.
 *
 * Threading note: this module runs inside the matrix Web Worker.
 * `indexedDB` is available in Workers, so no main-thread hops needed.
 */

const DB_NAME = 'mata-media-cache';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';
const STORE_META = 'meta';
const META_KEY_TOTAL = 'totalBytes';

// 150 MB soft cap — plenty for typical image-heavy rooms without
// straining the IDB quota (browsers usually grant 5-10% of disk).
// Eviction triggers above this; we drop until back under.
const MAX_BYTES = 150 * 1024 * 1024;

// Don't cache absurdly large items. A 50 MB video shouldn't push out
// 5,000 thumbnails. The caller still gets the bytes; we just skip
// the write-through. Threshold tuned to the largest "common" image
// (~8 MB phone photo) plus a margin.
const MAX_ITEM_BYTES = 16 * 1024 * 1024;

export interface MediaCacheEntry {
  data: ArrayBuffer;
  mime: string;
  size: number;
  accessedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let lastEvictAt = 0;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        const store = db.createObjectStore(STORE_BLOBS);
        store.createIndex('accessedAt', 'accessedAt');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb open failed'));
  });
  // If the open itself rejects, blow away the memo so a later call
  // can retry instead of latching onto the dead promise.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb tx error'));
    tx.onabort = () => reject(tx.error ?? new Error('idb tx abort'));
  });
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb req error'));
  });
}

/**
 * Look up a previously-cached plaintext blob. Returns `null` on miss
 * or on any error (cache failures are non-fatal — the caller will
 * fetch from network).
 *
 * Side effect: bumps `accessedAt` so the LRU ordering reflects
 * actual usage, not just write time. The bump is fire-and-forget;
 * we don't await it before returning the bytes.
 */
export async function getCachedMedia(mxc: string): Promise<MediaCacheEntry | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const entry = (await reqDone(tx.objectStore(STORE_BLOBS).get(mxc))) as
      | MediaCacheEntry
      | undefined;
    await txDone(tx).catch(() => {});
    if (!entry) return null;
    // Bump access time async — don't block the hit path.
    void bumpAccess(mxc).catch(() => {});
    return entry;
  } catch {
    return null;
  }
}

async function bumpAccess(mxc: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, 'readwrite');
  const store = tx.objectStore(STORE_BLOBS);
  const cur = (await reqDone(store.get(mxc))) as MediaCacheEntry | undefined;
  if (!cur) {
    await txDone(tx).catch(() => {});
    return;
  }
  cur.accessedAt = Date.now();
  store.put(cur, mxc);
  await txDone(tx).catch(() => {});
}

/**
 * Insert (or refresh) a decrypted blob in the cache. Caller passes
 * the raw plaintext bytes plus the MIME hint they want preserved.
 *
 * Skipped silently when:
 *   - the item is over `MAX_ITEM_BYTES` (don't let one giant video
 *     thrash the cache)
 *   - the runtime has no IndexedDB (some embedded webviews)
 *   - any IDB error occurs
 *
 * Eviction kicks off as a follow-up tx when total > MAX_BYTES,
 * throttled so back-to-back inserts don't queue redundant sweeps.
 */
export async function putCachedMedia(
  mxc: string,
  data: ArrayBuffer,
  mime: string,
): Promise<void> {
  if (data.byteLength > MAX_ITEM_BYTES) return;
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_BLOBS, STORE_META], 'readwrite');
    const blobs = tx.objectStore(STORE_BLOBS);
    const meta = tx.objectStore(STORE_META);

    const prev = (await reqDone(blobs.get(mxc))) as MediaCacheEntry | undefined;
    const totalPrev = ((await reqDone(meta.get(META_KEY_TOTAL))) as number | undefined) ?? 0;

    const entry: MediaCacheEntry = {
      data,
      mime,
      size: data.byteLength,
      accessedAt: Date.now(),
    };
    blobs.put(entry, mxc);
    const newTotal = totalPrev - (prev?.size ?? 0) + entry.size;
    meta.put(newTotal, META_KEY_TOTAL);

    await txDone(tx);

    if (newTotal > MAX_BYTES) {
      // Don't await — eviction runs in the background.
      void maybeEvict().catch(() => {});
    }
  } catch {
    /* non-fatal — the network round-trip is still authoritative */
  }
}

/**
 * Walk the `accessedAt` index ascending, dropping oldest entries
 * until total bytes fall below the cap. Throttled to once every 5s
 * so a burst of inserts doesn't trigger redundant sweeps.
 */
async function maybeEvict(): Promise<void> {
  const now = Date.now();
  if (now - lastEvictAt < 5000) return;
  lastEvictAt = now;

  const db = await openDb();
  const tx = db.transaction([STORE_BLOBS, STORE_META], 'readwrite');
  const blobs = tx.objectStore(STORE_BLOBS);
  const meta = tx.objectStore(STORE_META);
  const idx = blobs.index('accessedAt');

  let total = ((await reqDone(meta.get(META_KEY_TOTAL))) as number | undefined) ?? 0;
  if (total <= MAX_BYTES) {
    await txDone(tx).catch(() => {});
    return;
  }

  // Aim a bit under the cap so we don't immediately re-trigger on
  // the next insert. 90% leaves a 10% headroom buffer.
  const target = MAX_BYTES * 0.9;

  await new Promise<void>((resolve) => {
    const cursorReq = idx.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || total <= target) {
        meta.put(total, META_KEY_TOTAL);
        resolve();
        return;
      }
      const entry = cursor.value as MediaCacheEntry;
      total -= entry.size;
      cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => resolve();
  });

  await txDone(tx).catch(() => {});
}

/**
 * Hard reset — used by the worker on session change (different user
 * logged in) so we don't serve one account's plaintext to another.
 * Best-effort; failures are non-fatal.
 */
export async function clearMediaCache(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_BLOBS, STORE_META], 'readwrite');
    tx.objectStore(STORE_BLOBS).clear();
    tx.objectStore(STORE_META).clear();
    await txDone(tx);
  } catch {
    /* swallow */
  }
}
