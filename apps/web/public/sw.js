/* eslint-disable no-restricted-globals */
/**
 * Mata service worker.
 *
 * Strategy (intentionally tiny — no Workbox, no manifest):
 *
 *   1. `/assets/<hash>.<ext>` — cache-first, write-through on miss.
 *      Hashed + immutable, so cache entries never need invalidating.
 *      A new deploy ships new hashes; old entries linger harmlessly
 *      and get pruned on next activation when we bump the cache name.
 *
 *   2. `/sw.js` — network-only. Never cache the SW itself or we
 *      can't push fixes.
 *
 *   3. `/favicon.svg`, `/og-cover.jpg` — stale-while-revalidate.
 *      Brand assets, rarely change, fine to serve from cache while
 *      we refresh in the background.
 *
 *   4. `/` and other HTML navigations — network-first with cache
 *      fallback. Lets us paint instantly when offline / on a
 *      flaky network, but always reaches for a fresh shell when
 *      the network is up so the latest `<script src>` hashes win.
 *
 *   5. Everything else (CORS API calls, mxc media, Google Fonts,
 *      cross-origin XHR) — passthrough. The browser HTTP cache is
 *      the right layer for those; we don't want to fight matrix-js-sdk
 *      auth or font CDN ETags.
 *
 * Bump CACHE_VERSION when SW logic changes (not on every deploy —
 * asset filenames are already hashed). On activate, we delete any
 * cache whose name doesn't start with the current prefix.
 */

const CACHE_VERSION = 'v1';
const CACHE_PREFIX = 'mata-cache-';
const ASSET_CACHE = `${CACHE_PREFIX}assets-${CACHE_VERSION}`;
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const BRAND_CACHE = `${CACHE_PREFIX}brand-${CACHE_VERSION}`;

const SHELL_URL = '/';

self.addEventListener('install', (event) => {
  // Pre-warm the shell so the very first offline / flaky-net hit
  // already has something to fall back to. Failure here is fine —
  // we'll get it on the first successful navigation.
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        await cache.add(SHELL_URL);
      } catch {
        /* shell prewarm failed — non-fatal */
      }
      // NOTE: We intentionally do NOT call skipWaiting() here.
      //
      // Auto-activating a new SW mid-session swaps the asset cache out
      // from under a running SPA — if the live page lazy-loads a hashed
      // chunk that the new deploy renamed, it 404s and the app white-
      // screens. Instead we let the new worker sit in "waiting" and
      // surface the in-app "New version available · Update" banner
      // (driven by registration.waiting in main.tsx). The user clicks
      // Update -> we postMessage SKIP_WAITING (handled below) -> reload.
      //
      // First-ever install (no controller) still activates normally via
      // the browser's default flow, so brand-new visitors aren't
      // gated behind a banner.
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const stale = names.filter(
        (n) =>
          n.startsWith(CACHE_PREFIX) &&
          n !== ASSET_CACHE &&
          n !== SHELL_CACHE &&
          n !== BRAND_CACHE,
      );
      await Promise.all(stale.map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Route table — first match wins. Returning `null` means passthrough. */
function pickStrategy(request, url) {
  if (request.method !== 'GET') return null;
  if (url.origin !== self.location.origin) return null; // cross-origin: passthrough
  if (url.pathname === '/sw.js') return null;
  // Serverless functions (e.g. /api/preview) must always hit the
  // network — never the offline shell or any cache.
  if (url.pathname.startsWith('/api/')) return null;

  if (url.pathname.startsWith('/assets/')) return 'cache-first-assets';
  if (url.pathname === '/favicon.svg' || url.pathname === '/og-cover.jpg') {
    return 'swr-brand';
  }
  // Navigations (HTML). The SPA rewrites every non-asset URL to
  // /index.html on Vercel, so any navigation request lands here.
  if (request.mode === 'navigate') return 'network-first-shell';
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return 'network-first-shell';

  return null;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const strategy = pickStrategy(event.request, url);
  if (!strategy) return; // passthrough — browser handles normally

  event.respondWith(handle(event.request, strategy));
});

async function handle(request, strategy) {
  switch (strategy) {
    case 'cache-first-assets':
      return cacheFirst(request, ASSET_CACHE);
    case 'swr-brand':
      return staleWhileRevalidate(request, BRAND_CACHE);
    case 'network-first-shell':
      return networkFirstShell(request);
    default:
      return fetch(request);
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    // Don't cache opaque/error responses — they'd poison subsequent loads.
    if (res && res.ok && res.type === 'basic') {
      // Clone before .put — body is single-use.
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    // No cached copy, no network — let the failure bubble.
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') {
        cache.put(request, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  if (cached) {
    // Don't await the revalidation — let it run in the background.
    networkPromise.catch(() => {});
    return cached;
  }
  const fresh = await networkPromise;
  if (fresh) return fresh;
  throw new Error('swr: no cache and no network');
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      // Always store under the canonical shell URL so any nav route
      // falls back to the same cached document.
      cache.put(SHELL_URL, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = (await cache.match(request)) ?? (await cache.match(SHELL_URL));
    if (cached) return cached;
    throw err;
  }
}

// Allow the app to ask the SW to skipWaiting after a deploy. We don't
// rely on this today (skipWaiting fires on install), but the message
// hook is here for future "update available, click to apply" UX.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
