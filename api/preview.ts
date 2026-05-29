/**
 * Same-origin link-preview proxy (Vercel Edge function).
 *
 * Why this exists: link previews used to depend on either (a) the
 * homeserver's `/preview_url` endpoint — off by default on most
 * self-hosted Synapse installs — or (b) the browser fetching the target
 * page directly, which fails for the majority of sites because they
 * don't send permissive CORS headers. The net effect the user saw was
 * "previews not showing". A server-side fetch has no CORS constraint and
 * no homeserver dependency, so this resolves previews for any reachable
 * page. The browser calls it same-origin (`/api/preview`), so there's no
 * CORS hop on our own side either.
 *
 * Contract: GET /api/preview?url=<encoded http(s) url>
 *   200 { preview: UrlPreview | null }   — null = nothing scrapeable
 *   400 { preview: null }                — missing / non-http url
 * Always 200/400 with a JSON body; the client treats any failure as
 * "no card", same as before.
 */

export const config = { runtime: 'edge' };

interface UrlPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  siteName?: string;
}

const MAX_HTML = 96 * 1024; // OG/twitter meta lives in <head>; 96KB is plenty.

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // Same-origin in production, but keep it permissive so local dev
  // (vite on :3000 hitting a deployed proxy) and the web worker both work.
  'access-control-allow-origin': '*',
  // Edge + CDN cache: a preview is stable enough to cache for an hour,
  // and serving stale-while-revalidate keeps repeat links instant.
  'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400',
};

export default async function handler(req: Request): Promise<Response> {
  const target = new URL(req.url).searchParams.get('url');
  if (!target) return json({ preview: null }, 400);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return json({ preview: null }, 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return json({ preview: null }, 400);
  }

  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        // A real-ish browser UA + explicit HTML Accept gets us past most
        // CDN bot gates (Cloudflare etc.) that 403 a bare fetch UA.
        'user-agent':
          'Mozilla/5.0 (compatible; MataPreview/1.0; +https://immata.app)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok || !res.body) return json({ preview: null });

    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('html')) return json({ preview: null });

    // Stream, decode incrementally, stop at </head> or the byte cap.
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const reader = res.body.getReader();
    let text = '';
    while (text.length < MAX_HTML) {
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
      await reader.cancel();
    } catch {
      /* already drained */
    }

    const preview = scrape(text, parsed);
    return json({ preview });
  } catch {
    return json({ preview: null });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function scrape(head: string, base: URL): UrlPreview | null {
  const metaContent = (matcher: RegExp): string | undefined => {
    const m = head.match(matcher);
    return m?.[1] ? decodeEntities(m[1].trim()) : undefined;
  };
  // Both attribute orderings: property→content and content→property.
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

  const title = og('og:title') ?? og('twitter:title') ?? titleTag;
  const description =
    og('og:description') ?? og('twitter:description') ?? og('description');
  const rawImage = og('og:image') ?? og('twitter:image') ?? og('twitter:image:src');
  const siteName = og('og:site_name') ?? og('application-name');
  const image = rawImage ? resolveRelative(rawImage, base) : undefined;

  if (!title && !description && !image) return null;

  return {
    url: base.toString(),
    title,
    description,
    image,
    imageWidth: numericMeta(head, 'og:image:width'),
    imageHeight: numericMeta(head, 'og:image:height'),
    siteName,
  };
}

function numericMeta(head: string, key: string): number | undefined {
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
  return Number.isFinite(n) ? n : undefined;
}

function resolveRelative(href: string, base: URL): string | undefined {
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number.parseInt(d, 10));
      } catch {
        return _;
      }
    });
}
