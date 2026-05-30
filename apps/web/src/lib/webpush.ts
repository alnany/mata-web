/**
 * Web Push subscription lifecycle (client side).
 *
 * Enabling notifications is a two-layer thing:
 *   1. Foreground chime + in-tab toast — handled by the notifications
 *      store (`setNotifyEnabled`), needs only `Notification` permission.
 *   2. Background pushes when the tab is CLOSED — handled here. We ask
 *      the push service for a `PushSubscription`, then register it as an
 *      `http` pusher on the homeserver (`setWebPusher`) so it forwards
 *      matching events to our gateway (`/api/push`) → the SW `push`
 *      handler → a notification.
 *
 * The two are wired together at the settings toggle so the user flips one
 * switch. This module is intentionally dependency-light and idempotent:
 * re-enabling reuses the existing subscription and just refreshes the
 * pusher (the homeserver dedupes on pushkey = endpoint).
 */

import type { MatrixBridge } from '@mata/shared/rpc';

// Stable app id for the homeserver pusher. Must stay constant so
// re-subscribes update the same pusher rather than spawning duplicates.
const APP_ID = 'app.immata.web';

function gatewayUrl(): string {
  return `${location.origin}/api/push`;
}

/** VAPID public key (base64url) → Uint8Array for `applicationServerKey`. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True when this browser can do background push at all. */
export function webPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Subscribe to push + register the homeserver pusher. Assumes
 * `Notification.permission === 'granted'` (the caller gates on the user
 * gesture). Throws on unsupported browsers or a missing VAPID key so the
 * caller can surface a toast.
 */
export async function enableWebPush(bridge: MatrixBridge): Promise<void> {
  if (!webPushSupported()) throw new Error('Push not supported in this browser');

  const reg = await navigator.serviceWorker.ready;

  const res = await fetch('/api/vapid');
  const { publicKey } = (await res.json()) as { publicKey: string | null };
  if (!publicKey) throw new Error('Server is missing its push key');

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Push subscription is incomplete');
  }

  await bridge.request({
    kind: 'setWebPusher',
    subscription: {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    },
    gatewayUrl: gatewayUrl(),
    appId: APP_ID,
    lang: navigator.language || 'en',
  });
}

/**
 * Tear down background push: drop the homeserver pusher first (so it
 * stops forwarding), then unsubscribe locally. Best-effort — a failure
 * on either half shouldn't block the user from flipping the switch.
 */
export async function disableWebPush(bridge: MatrixBridge): Promise<void> {
  if (!webPushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try {
    await bridge.request({ kind: 'removeWebPusher', endpoint, appId: APP_ID });
  } catch {
    /* pusher removal failed — continue to local unsubscribe anyway */
  }
  try {
    await sub.unsubscribe();
  } catch {
    /* already gone — non-fatal */
  }
}
