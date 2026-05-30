/**
 * VAPID public-key endpoint (Vercel Edge function).
 *
 * The browser needs the server's VAPID *public* key as the
 * `applicationServerKey` when it calls `pushManager.subscribe()`. That
 * key is non-secret (it's literally handed to the push service), but we
 * keep it in a Vercel env var alongside the private key so the pair is
 * managed in one place and rotating it doesn't require a client rebuild.
 *
 * Contract: GET /api/vapid -> 200 { publicKey: string }
 *           500 { publicKey: null } when the env var is missing.
 *
 * Cached for a day at the edge — the key is stable across deploys.
 */

export const config = { runtime: 'edge' };

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=86400',
};

export default function handler(): Response {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? null;
  if (!publicKey) {
    return new Response(JSON.stringify({ publicKey: null }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify({ publicKey }), { status: 200, headers: JSON_HEADERS });
}
