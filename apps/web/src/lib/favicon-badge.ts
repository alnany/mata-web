// =============================================================================
// favicon-badge.ts — dynamic favicon dot when there's unread/highlight
//
// Strategy: rasterize the brand SVG once onto an offscreen canvas, then
// re-stamp a 96px accent-coloured dot (with a touch of stroke for tab
// contrast) in the lower-right corner whenever the tally changes. The
// resulting bitmap is pushed back into the <link rel="icon"> as a
// data URL.
//
// Why not just swap in pre-baked PNGs? Because the dot needs to honour
// the user's theme (lime for normal unread, red for highlights), and
// inlining two assets per tier (16/32/64) is heavier than 50 lines of
// canvas. The base mark rasterizes once at boot and is cached.
//
// We avoid touching favicon when document is hidden (no observable
// effect until they refocus anyway, no point burning CPU).
// =============================================================================

const FAVICON_HREF = '/favicon.svg';
const SIZE = 64; // chrome scales to 16/32 as needed; 64 gives a clean dot

let baseBitmap: ImageBitmap | null = null;
let canvas: HTMLCanvasElement | null = null;
let linkEl: HTMLLinkElement | null = null;
let lastKey = '';

async function loadBase(): Promise<ImageBitmap | null> {
  if (baseBitmap) return baseBitmap;
  try {
    const res = await fetch(FAVICON_HREF, { credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    baseBitmap = await createImageBitmap(blob, { resizeWidth: SIZE, resizeHeight: SIZE });
    return baseBitmap;
  } catch {
    return null;
  }
}

function ensureCanvas(): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
  }
  return canvas;
}

function ensureLink(): HTMLLinkElement | null {
  if (linkEl) return linkEl;
  // Prefer the existing <link>. If none, create one so we can hijack it.
  const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (existing) {
    linkEl = existing;
    return linkEl;
  }
  const created = document.createElement('link');
  created.rel = 'icon';
  document.head.appendChild(created);
  linkEl = created;
  return linkEl;
}

export async function paintFaviconBadge(input: {
  unread: number;
  highlights: number;
}): Promise<void> {
  const key = `${input.unread}|${input.highlights}`;
  if (key === lastKey) return;
  lastKey = key;

  const link = ensureLink();
  if (!link) return;

  // Zero state — restore the static SVG so we don't pay re-paint cost
  // on every tab focus and we get whatever DPR the browser picks.
  if (input.unread === 0 && input.highlights === 0) {
    if (link.getAttribute('href') !== FAVICON_HREF) {
      link.setAttribute('href', FAVICON_HREF);
      link.setAttribute('type', 'image/svg+xml');
    }
    return;
  }

  const base = await loadBase();
  if (!base) return;

  const c = ensureCanvas();
  const ctx = c.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(base, 0, 0, SIZE, SIZE);

  // Dot — lime (#c8f64d, brand accent) for unread, vermilion (#ef4444)
  // for highlights. A 1.5px dark ring keeps the dot legible against
  // both the white tab background (chrome on light theme) and the
  // black brand square underneath.
  const cx = SIZE - 14;
  const cy = SIZE - 14;
  const r = 14;

  const isHighlight = input.highlights > 0;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = isHighlight ? '#ef4444' : '#c8f64d';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0a0a0b';
  ctx.stroke();

  const dataUrl = c.toDataURL('image/png');
  if (link.getAttribute('href') !== dataUrl) {
    link.setAttribute('href', dataUrl);
    link.setAttribute('type', 'image/png');
  }
}
