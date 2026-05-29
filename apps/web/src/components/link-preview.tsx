// ============================================================================
// LinkPreviewCard — OG-style card under message bodies that contain a URL.
//
// Lifecycle:
//   1. MessageBubble extracts the first http(s) URL from the body via
//      `extractFirstUrl` and renders <LinkPreviewCard url={url} />.
//   2. On mount, the card looks up the URL in a module-level Map cache.
//      Cache hit → render immediately (no flash). Cache miss → request
//      via bridge, store the result (`UrlPreview | null`), render.
//   3. Null result means "no usable OG metadata" — the card collapses to
//      nothing and the body just shows the plain URL.
//
// Why a module-level cache: the same URL may appear in many messages
// across rooms (a project doc, a shared image, etc.). The cache lives
// for the session, so re-renders during scroll, room switch, or
// virtualization re-mount cost zero round-trips.
//
// Why `null` is cached too: prevents re-asking the homeserver for
// URLs we already know it can't preview (404s, opaque images, etc.).
// ============================================================================

import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type { UrlPreview } from '@mata/shared/rpc';
import { useBridge } from '../bridge/context.js';

// Pending fetches share a single Promise so 5 bubbles mounting in the
// same tick (e.g. paginated history load) hit the homeserver once,
// not five times.
const cache = new Map<string, UrlPreview | null>();
const inflight = new Map<string, Promise<UrlPreview | null>>();

/**
 * Extract the first http(s) URL we'd want to preview from a message
 * body. Bounded — at most one preview per message even if the body
 * has multiple links (Element / Telegram pattern; multiple cards
 * stacked under one bubble are visually noisy).
 *
 * Excludes inline-mention pseudo-URLs (matrix.to user/event refs) so
 * a reply with `@alice` doesn't render a "matrix.to" card.
 *
 * Two passes:
 *   1. Explicit `http(s)://...` scheme (high confidence).
 *   2. Bare hostnames like `immata.app` or `vercel.com/docs` when
 *      the TLD looks plausible (allowlist below). We assume `https://`
 *      because every site that ships a unfurl-able OG card is on
 *      TLS anyway, and the preview endpoint will gracefully fail
 *      on the rare non-TLS host without hurting the user.
 */
export function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  // Pass 1 — explicit scheme.
  const reHttp = /https?:\/\/[^\s<>"'`]+/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
  while ((m = reHttp.exec(text)) !== null) {
    const url = stripTrailingPunct(m[0]);
    if (!url) continue;
    if (url.includes('matrix.to/#/')) continue;
    return url;
  }
  // Pass 2 — bare hostname. Require a leading word boundary so we
  // don't slice the back half of an unmatched scheme, and a known
  // TLD so we don't preview `e.g.` or `lib.ts`.
  const reBare =
    /(^|[\s(<[{"'`])([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(\/[^\s<>"'`]*)?/gi;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
  while ((m = reBare.exec(text)) !== null) {
    const host = m[2];
    const path = m[3] ?? '';
    const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
    if (!KNOWN_TLDS.has(tld)) continue;
    // Skip emails: a `@` immediately before the start of the host
    // means we matched the right side of `user@example.com`.
    const startIdx = m.index + (m[1]?.length ?? 0);
    if (startIdx > 0 && text[startIdx - 1] === '@') continue;
    const url = `https://${stripTrailingPunct(host + path)}`;
    return url;
  }
  return null;
}

/**
 * TLD allowlist — covers the long tail of bare-domain references
 * people actually type in chat (product names, marketing sites,
 * personal pages). Conservative on purpose: a missing TLD just
 * means no preview, which is the safe failure mode. Extend as the
 * product encounters new ones (better than regexing every label).
 */
const KNOWN_TLDS = new Set<string>([
  // generic
  'com', 'net', 'org', 'info', 'biz', 'name', 'pro', 'mobi',
  // tech / startup
  'io', 'ai', 'app', 'dev', 'sh', 'co', 'xyz', 'tech', 'cloud',
  'run', 'page', 'site', 'store', 'link', 'chat', 'social', 'studio',
  'design', 'agency', 'tools', 'wtf', 'lol', 'fyi', 'gg', 'ly',
  // media / personal
  'me', 'tv', 'fm', 'am', 'im', 'is', 'to', 'cc', 'so', 'mx',
  'news', 'blog', 'today', 'world', 'online', 'live', 'video',
  'photo', 'art',
  // ccTLDs
  'us', 'uk', 'de', 'fr', 'jp', 'ca', 'au', 'eu', 'in', 'br',
  'cn', 'ru', 'nl', 'es', 'it', 'ch', 'se', 'no', 'fi', 'dk',
  'pl', 'kr', 'tw', 'hk', 'sg', 'nz', 'za', 'tr', 'ar', 'cl',
  'be', 'at', 'cz', 'ie', 'pt', 'gr', 'il', 'th', 'vn', 'id',
  'ph', 'my', 'ua', 'ro', 'hu',
]);

function stripTrailingPunct(s: string): string {
  // ")" / "," / "." / "?" / "!" frequently end sentences, not URLs.
  // But ")" is legal in Wikipedia paths — only strip when unbalanced.
  let out = s;
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (',.;!?'.includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ')' && !out.includes('(')) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

export function LinkPreviewCard(props: { url: string; isMine: boolean }) {
  const bridge = useBridge();
  const [preview, setPreview] = createSignal<UrlPreview | null | undefined>(
    cache.get(props.url),
  );

  onMount(async () => {
    if (cache.has(props.url)) return; // already settled (hit or known-null)

    let p = inflight.get(props.url);
    if (!p) {
      p = (async () => {
        try {
          const res = await bridge.request({ kind: 'getUrlPreview', url: props.url });
          return res.preview;
        } catch {
          return null;
        }
      })();
      inflight.set(props.url, p);
    }
    const result = await p;
    inflight.delete(props.url);
    cache.set(props.url, result);
    setPreview(result);
  });

  return (
    <Show when={preview()}>
      {(p) => <Card preview={p()} isMine={props.isMine} />}
    </Show>
  );
}

function Card(props: { preview: UrlPreview; isMine: boolean }): JSX.Element {
  const p = props.preview;
  const host = (() => {
    try {
      return new URL(p.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();

  // Visual: thin left accent bar (Telegram pattern), 4-column layout
  // with thumbnail right when image present, stacked when not. The
  // border tint flips with bubble side so it still reads on the
  // accent-colored "mine" bubble.
  const accentColor = props.isMine ? 'rgba(255,255,255,0.55)' : 'var(--color-mata-500)';

  return (
    <a
      href={p.url}
      target="_blank"
      rel="noreferrer noopener"
      class={`mt-1.5 block max-w-full overflow-hidden rounded-lg border text-xs no-underline transition-colors ${
        props.isMine
          ? 'border-white/25 bg-white/10 hover:bg-white/15'
          : 'border-line bg-base hover:bg-input'
      }`}
      style={{ 'border-left': `3px solid ${accentColor}` }}
      onClick={(e) => e.stopPropagation()}
    >
      <Show when={p.image} fallback={<TextOnly preview={p} host={host} isMine={props.isMine} />}>
        {(img) => (
          <div class="flex gap-2 p-2">
            <div class="min-w-0 flex-1">
              <Meta preview={p} host={host} isMine={props.isMine} />
            </div>
            <PreviewImage src={img()} />
          </div>
        )}
      </Show>
    </a>
  );
}

/**
 * Image renderer that handles both `http(s)://` (use directly) and
 * `mxc://` (fetch authenticated bytes via the worker, render as
 * Blob URL — same pipeline as message images). Synapse's
 * authenticated-media mode requires a bearer token on every media
 * GET; a plain `<img>` tag can't attach one, so the only path that
 * actually renders is fetch-then-blob.
 *
 * Errors are silenced — a missing preview thumbnail is not worth
 * showing the user a broken-image glyph for. The text card alone
 * still gives them enough context.
 */
function PreviewImage(props: { src: string }): JSX.Element {
  const bridge = useBridge();
  const isMxc = props.src.startsWith('mxc://');

  if (!isMxc) {
    return (
      <img
        src={props.src}
        alt=""
        loading="lazy"
        referrerpolicy="no-referrer"
        class="h-16 w-16 shrink-0 rounded-md object-cover"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
    );
  }

  // mxc:// path — fetch via authenticated worker pipeline.
  const [blobUrl, setBlobUrl] = createSignal<string | null>(null);
  let revokable: string | null = null;

  onMount(async () => {
    try {
      const res = await bridge.request({
        kind: 'loadMedia',
        mxc: props.src,
        encryptedFile: null, // OG thumbnails are always plaintext
        mime: 'image/*',
      });
      const blob = new Blob([res.data], { type: res.mime || 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      revokable = url;
      setBlobUrl(url);
    } catch {
      // Swallow — card collapses to text-only via onError below.
    }
  });

  onCleanup(() => {
    if (revokable) URL.revokeObjectURL(revokable);
  });

  return (
    <Show when={blobUrl()}>
      {(u) => (
        <img
          src={u()}
          alt=""
          loading="lazy"
          class="h-16 w-16 shrink-0 rounded-md object-cover"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
    </Show>
  );
}

function TextOnly(props: { preview: UrlPreview; host: string; isMine: boolean }) {
  return (
    <div class="p-2">
      <Meta preview={props.preview} host={props.host} isMine={props.isMine} />
    </div>
  );
}

function Meta(props: { preview: UrlPreview; host: string; isMine: boolean }) {
  const p = props.preview;
  const subColor = props.isMine ? 'text-accent-ink/70' : 'text-fg-3';
  return (
    <>
      <Show when={p.siteName || props.host}>
        <div class={`mb-0.5 truncate text-[10px] uppercase tracking-wide ${subColor}`}>
          {p.siteName || props.host}
        </div>
      </Show>
      <Show when={p.title}>
        <div class="line-clamp-2 font-semibold leading-tight">{p.title}</div>
      </Show>
      <Show when={p.description}>
        <div class={`mt-0.5 line-clamp-2 ${subColor}`}>{p.description}</div>
      </Show>
    </>
  );
}
