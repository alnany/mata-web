/**
 * Matrix Push Gateway → Web Push bridge (Vercel Node function).
 *
 * The user's homeserver holds an `http` pusher (registered by the worker
 * via `setWebPusher`) whose `data` carries the browser PushSubscription
 * (endpoint + p256dh + auth). Whenever a push rule matches — including
 * when the tab is closed — the homeserver POSTs a Push Gateway
 * notification here. We translate that into an encrypted Web Push (RFC
 * 8291) and hand it to the browser's push service, which wakes the
 * service worker's `push` handler.
 *
 * Node runtime (not Edge): the `web-push` library leans on Node's crypto
 * for the ECDH/HKDF/AES-GCM + VAPID-JWT (ES256) dance. Reimplementing
 * that on Web Crypto would be ~150 lines of footguns; the library is the
 * boring, correct path.
 *
 * Spec: https://spec.matrix.org/latest/push-gateway-api/
 *   POST /api/push  { notification: { ..., devices: [{ pushkey, data }] } }
 *   200 { rejected: string[] }   — pushkeys the homeserver should drop
 *                                  (we return a pushkey when its push
 *                                   subscription is 404/410 Gone).
 */

import webpush from 'web-push';

interface PushDevice {
  app_id?: string;
  pushkey?: string;
  data?: { endpoint?: string; p256dh?: string; auth?: string } | null;
}

interface MatrixNotification {
  event_id?: string;
  room_id?: string;
  type?: string;
  sender?: string;
  sender_display_name?: string;
  room_name?: string;
  content?: { msgtype?: string; body?: string } | null;
  counts?: { unread?: number } | null;
  devices?: PushDevice[];
}

/** Build the small JSON payload the service worker renders into a toast. */
function buildPayload(n: MatrixNotification): string {
  const sender = n.sender_display_name || n.sender || 'Someone';
  const hasBody = typeof n.content?.body === 'string' && n.content.body.length > 0;
  // Encrypted rooms arrive without content (we register the pusher in
  // full format, so cleartext rooms DO include the body). Degrade to a
  // generic line when there's nothing to show.
  const title = n.room_name || sender;
  let body: string;
  if (hasBody) {
    body = n.room_name ? `${sender}: ${n.content!.body}` : (n.content!.body as string);
  } else {
    body = n.room_name ? `${sender} sent a message` : 'New message';
  }
  return JSON.stringify({
    title,
    body: body.slice(0, 300),
    roomId: n.room_id ?? null,
    eventId: n.event_id ?? null,
  });
}

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ rejected: [] });
    return;
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:push@immata.app';
  if (!publicKey || !privateKey) {
    // Misconfigured — don't ask the homeserver to drop anything.
    res.status(200).json({ rejected: [] });
    return;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);

  // Vercel parses JSON bodies for Node functions; fall back defensively.
  let body: { notification?: MatrixNotification };
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
  } catch {
    res.status(400).json({ rejected: [] });
    return;
  }

  const notification = body.notification;
  if (!notification) {
    res.status(400).json({ rejected: [] });
    return;
  }

  const devices = Array.isArray(notification.devices) ? notification.devices : [];

  // A notification with no event_id is a "clear"/badge-only ping. We have
  // no per-event content to show, so skip dispatch (the in-app unread
  // count already covers badges) and accept all devices.
  if (!notification.event_id) {
    res.status(200).json({ rejected: [] });
    return;
  }

  const payload = buildPayload(notification);
  const rejected: string[] = [];

  await Promise.all(
    devices.map(async (d) => {
      const data = d.data;
      const endpoint = data?.endpoint;
      const p256dh = data?.p256dh;
      const auth = data?.auth;
      if (!endpoint || !p256dh || !auth) return;
      try {
        await webpush.sendNotification(
          { endpoint, keys: { p256dh, auth } },
          payload,
          { TTL: 60 * 60 * 24, urgency: 'high' },
        );
      } catch (err: any) {
        const code = err?.statusCode;
        // 404/410 = the push subscription is permanently gone. Tell the
        // homeserver to drop this pusher so it stops retrying.
        if ((code === 404 || code === 410) && d.pushkey) {
          rejected.push(d.pushkey);
        }
        // Other errors (timeouts, 5xx) are transient — leave the pusher.
      }
    }),
  );

  res.status(200).json({ rejected });
}
