/**
 * Link-preview resolution for the Matrix worker.
 *
 * Extracted from sdk-impl.ts to keep that file under the worker's
 * blob-upload size ceiling and to isolate ~200 lines of OG/HTML
 * string-munging from the session class. Three paths converge on the
 * same `UrlPreview` shape and are chained by `SdkSession.getUrlPreview`:
 *   1. parseHsPreview        — homeserver /preview_url payload
 *   2. fetchPreviewViaProxy  — our same-origin /api/preview Edge proxy
 *   3. fetchPreviewClientSide — direct browser OG scrape (CORS-bound)
 */
import type { UrlPreview } from '@mata/shared/rpc';

export function parseHsPreview(
  raw: Record<string, unknown>,
  url: string,
): UrlPreview | null {
  const pick = (k: string): string | undefined => {
    const v = raw[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const pickNum = (k: string): number | undefined => {
    const v = raw[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const title = pick('og:title');
  const description = pick('og:description');
  const image = pick('og:image');
  const siteName = pick('og:site_name');
  if (!title && !description && !image) return null;
  return {
    url,
    title,
    description,
    image,
    imageWidth: pickNum('og:image:width'),
    imageHeight: pickNum('og:image:height'),
    siteName,
  };
}

/**
 * Direct-from-browser OG scrape, used when the homeserver can't (or
 * won't) preview the URL. CORS-bound by nature: works for sites that
 * ship `access-control-allow-origin: *` (Vercel-hosted projects, many
 * CDNs, the Mata marketing site itself); silently returns null for
 * everything else. That's intentional — the failure mode is "no
 * card", same as a homeserver miss.
 *
 * Bounded read: OG / twitter meta lives in <head>, so reading the
 * first ~96 KB and cutting at </head> is enough for >99% of pages.
 */
/**
 * Resolve a preview through our same-origin Edge proxy (`/api/preview`).
 * Server-side fetch → no CORS limit, no homeserver dependency. Returns
 * null on any failure (proxy unreachable in dev, page un-scrapeable,
 * network error) so the caller falls through to the direct-fetch path.
 *
 * The worker runs at the app origin, so a root-relative URL resolves to
 * `https://immata.app/api/preview` in production.
 */
export async function fetchPreviewViaProxy(url: string): Promise<UrlPreview | null> {
  try {
    const origin =
      typeof self !== 'undefined' && self.location?.origin ? self.location.origin : '';
    // Bail in dev/test where there's no real origin to hit — the
    // direct-fetch fallback covers that case.
    if (!origin || origin.startsWith('file:')) return null;
    const res = await fetch(`${origin}/api/preview?url=${encodeURIComponent(url)}`, {
      method: 'GET',
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { preview: UrlPreview | null };
    return body?.preview ?? null;
  } catch {
    return null;
  }
}

export async function fetchPreviewClientSide(url: string): Promise<UrlPreview | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      // Some servers gate HTML on a real-ish UA. The default fetch
      // UA inside a Worker is too sparse for picky CDNs (e.g.
      // Cloudflare's bot-fight). We can't override `User-Agent`
      // from the browser, but we can ask explicitly for HTML.
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok || !res.body) return null;

    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('html')) return null;

    // Stream up to ~96KB, decoding incrementally so a long page
    // doesn't pull the whole body into memory just to throw it
    // away after the </head>.
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const reader = res.body.getReader();
    let text = '';
    const MAX = 96 * 1024;
    while (text.length < MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const idx = text.toLowerCase().indexOf('</head>');
      if (idx !== -1) {
        text = text.slice(0, idx);
        break;
      }
    }
    try {
      reader.cancel();
    } catch {
      // already done — irrelevant
    }

    const head = text;

    const metaContent = (matcher: RegExp): string | undefined => {
      const m = head.match(matcher);
      if (!m) return undefined;
      const raw = m[1];
      return raw ? decodeEntities(raw.trim()) : undefined;
    };

    // Two attribute orderings per key — `property="og:x" content="y"`
    // and the reversed `content="y" property="og:x"`. Keep regexes
    // anchored to <meta ...> so we don't pick up content from unrelated
    // tags that happen to share a substring.
    const og = (key: string): string | undefined => {
      const k = escapeRegex(key);
      return (
        metaContent(
          new RegExp(
            `<meta\\b[^>]*?(?:property|name)\\s*=\\s*["']${k}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
            'i',
          ),
        ) ??
        metaContent(
          new RegExp(
            `<meta\\b[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${k}["']`,
            'i',
          ),
        )
      );
    };

    const titleTag = (() => {
      const m = head.match(/<title[^>]*>([^<]+)<\/title>/i);
      return m?.[1] ? decodeEntities(m[1].trim()) : undefined;
    })();
    const descMeta = og('description');

    const title = og('og:title') ?? og('twitter:title') ?? titleTag;
    const description = og('og:description') ?? og('twitter:description') ?? descMeta;
    const rawImage = og('og:image') ?? og('twitter:image') ?? og('twitter:image:src');
    const siteName = og('og:site_name') ?? og('application-name');

    const image = rawImage ? resolveRelative(rawImage, parsed) : undefined;

    if (!title && !description && !image) return null;

    const imageWidth = numericMeta(head, ['og:image:width']);
    const imageHeight = numericMeta(head, ['og:image:height']);

    return {
      url,
      title,
      description,
      image,
      imageWidth,
      imageHeight,
      siteName,
    };
  } catch {
    return null;
  }
}

function resolveRelative(href: string, base: URL): string | undefined {
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

function numericMeta(head: string, keys: string[]): number | undefined {
  for (const key of keys) {
    const k = escapeRegex(key);
    const m =
      head.match(
        new RegExp(
          `<meta\\b[^>]*?(?:property|name)\\s*=\\s*["']${k}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
          'i',
        ),
      ) ??
      head.match(
        new RegExp(
          `<meta\\b[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${k}["']`,
          'i',
        ),
      );
    const n = m?.[1] ? Number.parseInt(m[1], 10) : Number.NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function escapeRegex(s: string): string {
  // Backslash-escape every regex metachar.
  return s.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
}

// Minimal HTML entity decoder — covers the entities that actually
// show up in OG/title text. A real entity table is overkill for
// link previews and would bloat the worker bundle.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = Number.parseInt(h, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number.parseInt(d, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    });
}
