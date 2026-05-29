// =============================================================================
// favicon-badge.ts — dynamic favicon with a numeric unread badge
//
// Strategy: rasterize the brand SVG once onto an offscreen canvas, then
// stamp a rounded badge carrying the unread COUNT (not a bare dot) in the
// lower-right corner whenever the tally changes. The resulting bitmap is
// pushed back into the <link rel="icon"> as a PNG data URL.
//
// Why an <img> element and not createImageBitmap? Our favicon.svg declares
// a `viewBox` but no intrinsic width/height. Chromium's
// `createImageBitmap(svgBlob, { resizeWidth, resizeHeight })` rejects such
// SVGs ("source image contains no data" / zero-sized raster), so the badge
// silently never rendered. An HTMLImageElement with explicit width/height
// rasterizes a viewBox-only SVG reliably across Chrome/Firefox/Safari.
//
// Colour: lime (#c8f64d, brand accent) for ordinary unread, vermilion
// (#ef4444) for highlights (mentions / DMs). Count caps at "99+".
//
// We avoid touching favicon when document is hidden (no observable effect
// until they refocus anyway, no point burning CPU).
// =============================================================================

const FAVICON_HREF = '/favicon.svg';
const SIZE = 64; // chrome scales to 16/32 as needed; 64 gives a clean badge

let baseImg: HTMLImageElement | null = null;
let basePromise: Promise<HTMLImageElement | null> | null = null;
let canvas: HTMLCanvasElement | null = null;
let linkEl: HTMLLinkElement | null = null;
let lastKey = '';

function loadBase(): Promise<HTMLImageElement | null> {
  if (baseImg) return Promise.resolve(baseImg);
  if (basePromise) return basePromise;
  basePromise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image(SIZE, SIZE);
    img.width = SIZE;
    img.height = SIZE;
    img.decoding = 'async';
    img.onload = () => {
      baseImg = img;
      resolve(img);
    };
    img.onerror = () => resolve(null);
    // SVG with a viewBox rasterizes to width/height when those are set.
    img.src = FAVICON_HREF;
  });
  return basePromise;
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

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export async function paintFaviconBadge(input: {
  unread: number;
  highlights: number;
}): Promise<void> {
  const total = input.unread;
  const key = `${total}|${input.highlights}`;
  if (key === lastKey) return;
  lastKey = key;

  const link = ensureLink();
  if (!link) return;

  // Zero state — restore the static SVG so we don't pay re-paint cost on
  // every tab focus and we get whatever DPR the browser picks.
  if (total === 0 && input.highlights === 0) {
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

  const isHighlight = input.highlights > 0;
  const label = total > 99 ? '99+' : String(Math.max(total, isHighlight ? 1 : 0));

  // Badge geometry: a pill anchored bottom-right, widening for 2–3 glyphs.
  const h = 30;
  const padX = 7;
  ctx.font = '700 26px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textW = ctx.measureText(label).width;
  const w = Math.max(h, Math.ceil(textW) + padX * 2);
  const x = SIZE - w - 2;
  const y = SIZE - h - 2;

  // Dark outline ring keeps the pill legible on both light and dark tabs.
  roundRect(ctx, x - 1.5, y - 1.5, w + 3, h + 3, (h + 3) / 2);
  ctx.fillStyle = '#0a0a0b';
  ctx.fill();

  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = isHighlight ? '#ef4444' : '#c8f64d';
  ctx.fill();

  // Text colour for contrast: dark glyphs on lime, white on vermilion.
  ctx.fillStyle = isHighlight ? '#ffffff' : '#0a0a0b';
  ctx.fillText(label, x + w / 2, y + h / 2 + 1);

  const dataUrl = c.toDataURL('image/png');
  if (link.getAttribute('href') !== dataUrl) {
    link.setAttribute('href', dataUrl);
    link.setAttribute('type', 'image/png');
  }
}
