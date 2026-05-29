/**
 * Same-origin message-translation proxy (Vercel Edge function).
 *
 * Why this exists: translating a chat message client-side means hitting
 * a translation endpoint from the browser, which fails CORS on every
 * free provider. A server-side fetch has no CORS constraint, so this
 * resolves translations for any reachable text. The browser calls it
 * same-origin (`/api/translate`), so there's no CORS hop on our side.
 *
 * Backend: Google's public `translate_a/single` gtx endpoint — keyless,
 * widely used, auto-detects the source language. We keep the contract
 * provider-agnostic so the backend can be swapped without touching the
 * client.
 *
 * Contract: POST /api/translate  { text: string, target: string }
 *   200 { text: string, source: string | null }  — translated text + detected source lang
 *   200 { text: null, source: null }              — nothing to translate / upstream failure
 *   400 { text: null, source: null }              — bad body
 * Always JSON; the client treats any null as "couldn't translate".
 */

export const config = { runtime: 'edge' };

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const MAX_CHARS = 5000; // gtx truncates beyond ~5k; clamp defensively.

function fail(status: number): Response {
  return new Response(JSON.stringify({ text: null, source: null }), {
    status,
    headers: JSON_HEADERS,
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }
  if (req.method !== 'POST') return fail(405);

  let body: { text?: unknown; target?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400);
  }

  const text = typeof body.text === 'string' ? body.text.slice(0, MAX_CHARS).trim() : '';
  const target = typeof body.target === 'string' && body.target ? body.target : 'en';
  if (!text) return fail(400);

  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto' +
    `&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;

  try {
    const upstream = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MataTranslate/1.0)' },
    });
    if (!upstream.ok) return new Response(JSON.stringify({ text: null, source: null }), {
      status: 200,
      headers: JSON_HEADERS,
    });
    // Shape: [[["translated","original",...],...], null, "detectedSourceLang", ...]
    const data = (await upstream.json()) as [Array<[string, string]>, unknown, string?];
    const segments = Array.isArray(data?.[0]) ? data[0] : [];
    const translated = segments.map((s) => (Array.isArray(s) ? s[0] : '')).join('');
    const source = typeof data?.[2] === 'string' ? data[2] : null;
    if (!translated) return new Response(JSON.stringify({ text: null, source: null }), {
      status: 200,
      headers: JSON_HEADERS,
    });
    return new Response(JSON.stringify({ text: translated, source }), {
      status: 200,
      headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=86400' },
    });
  } catch {
    return new Response(JSON.stringify({ text: null, source: null }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
}
