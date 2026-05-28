/**
 * Mata brand surfaces.
 *
 * Two visually distinct artifacts live under the same brand identity:
 *
 *   1. `<Mark>`        — the standalone ring+bar SVG. The single source of
 *                        truth for the logo (favicon, splash, boot screen,
 *                        login, anywhere a non-rail mark appears).
 *   2. `<BrandSquare>` — the workspace-rail brand tile. Lime square with
 *                        an Instrument Serif italic `M` glyph. This is NOT
 *                        the SVG mark; it's typographic-on-accent by design
 *                        (see LOGO.md §"Application: in-product · Workspace
 *                        rail brand square").
 *
 * SVG paths copied verbatim from /agents/<id>/skills/mata-design/LOGO.md.
 * Do NOT redraw or recolor. The design's "Don'ts" list explicitly forbids
 * stroke-width fiddling at intermediate sizes — switch optical tier by
 * container size instead.
 */

import { Show } from 'solid-js';

export type MarkSize =
  | 'display' // 40+ px
  | 'optical' // 14–40 px
  | 'pixel'; // 10–14 px (favicons, menubar)

/**
 * Standalone Mata mark. Renders one of three optical SVG variants. The
 * caller controls outer dimensions via the wrapping element's CSS; the
 * SVG is `width="100%" height="100%"`.
 *
 * Ring color falls out of `currentColor`. Set the wrapping element's
 * `color: …` (paper `#ededee` on dark surfaces, ink `#0a0a0b` on light /
 * lime surfaces — see LOGO.md §"Allowed lockup surface combinations").
 */
export function Mark(props: { size?: MarkSize; class?: string; barColor?: string }) {
  const bar = () => props.barColor ?? '#c8f64d';
  return (
    <Show
      when={(props.size ?? 'display') === 'display'}
      fallback={
        <Show
          when={(props.size ?? 'display') === 'optical'}
          fallback={
            // Pixel variant — edge-to-edge bar so it doesn't shrink to a
            // dot below 14px. Crisp edges via shape-rendering.
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 320 320"
              shape-rendering="crispEdges"
              role="img"
              aria-label="Mata"
              class={`block h-full w-full ${props.class ?? ''}`}
            >
              <title>Mata</title>
              <circle cx="160" cy="160" r="112" fill="none" stroke="currentColor" stroke-width="36" />
              <rect x="0" y="142" width="320" height="36" fill={bar()} />
            </svg>
          }
        >
          {/* Optical variant — 14–40px tier. */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 320 320"
            role="img"
            aria-label="Mata"
            class={`block h-full w-full ${props.class ?? ''}`}
          >
            <title>Mata</title>
            <circle cx="160" cy="160" r="116" fill="none" stroke="currentColor" stroke-width="22" />
            <rect x="20" y="148" width="280" height="24" fill={bar()} />
          </svg>
        </Show>
      }
    >
      {/* Display variant — canonical 40+px. */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 320 320"
        role="img"
        aria-label="Mata"
        class={`block h-full w-full ${props.class ?? ''}`}
      >
        <title>Mata</title>
        <circle cx="160" cy="160" r="120" fill="none" stroke="currentColor" stroke-width="14" />
        <rect x="20" y="153" width="280" height="14" fill={bar()} />
      </svg>
    </Show>
  );
}

/**
 * Workspace-rail brand tile. Lime square with an italic serif `M`. Per
 * LOGO.md §"Application: in-product · Workspace rail brand square":
 * 38×38 outer, 9px radius, lime background, italic `M` in Instrument
 * Serif 22px. We render the glyph live (not as SVG) so it picks up the
 * loaded font; if Instrument Serif hasn't loaded yet, the fallback is
 * Georgia italic — close enough not to flash.
 *
 * The 1px outline ring 3px outside the tile (per spec) is rendered via
 * a wrapper element with `box-shadow` rather than `::after` because
 * Solid + Tailwind v4 want the rendering in JSX.
 */
export function BrandSquare(props: { size?: number; class?: string }) {
  const sz = () => props.size ?? 38;
  return (
    <div
      class={`relative shrink-0 ${props.class ?? ''}`}
      style={{ width: `${sz()}px`, height: `${sz()}px` }}
      aria-label="Mata"
      role="img"
    >
      <div
        class="flex h-full w-full items-center justify-center select-none"
        style={{
          'background-color': 'var(--color-accent)',
          color: 'var(--color-accent-ink)',
          'border-radius': '9px',
          'font-family': "'Instrument Serif', Georgia, serif",
          'font-style': 'italic',
          'font-size': `${Math.round(sz() * 0.58)}px`,
          'letter-spacing': '-0.02em',
          'line-height': '1',
        }}
      >
        M
      </div>
      {/* 1px outline ring 3px outside, faded accent. */}
      <div
        class="pointer-events-none absolute -inset-[3px] rounded-[12px]"
        style={{
          border: '1px solid color-mix(in oklab, var(--color-accent) 22%, transparent)',
        }}
      />
    </div>
  );
}
