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
 * Workspace-rail brand tile — the iOS "Default" app-icon variant from
 * LOGO.md §"App icon (iOS / macOS)": dark `#0a0a0b` squircle background,
 * paper ring + lime bar mark centered at ~33% of canvas width. We render
 * the squircle as a 9px-radius rounded square (the iOS OS-applied radius
 * is for the 1024px canvas; at 38px the rail spec calls for 9px).
 *
 * The 1px outline ring 3px outside the tile (per spec) is rendered via a
 * sibling element with `border` rather than `::after` because Solid +
 * Tailwind v4 want the rendering in JSX.
 */
export function BrandSquare(props: { size?: number; class?: string }) {
  const sz = () => props.size ?? 38;
  // Mark sits at ~52% of canvas in the rail (slightly tighter than the
  // 33% iOS app-icon ratio because the rail tile already lives inside a
  // 64px gutter — needs to read as a logo, not a dot).
  const markPct = 52;
  return (
    <div
      class={`relative shrink-0 ${props.class ?? ''}`}
      style={{ width: `${sz()}px`, height: `${sz()}px` }}
      aria-label="Mata"
      role="img"
    >
      <div
        class="flex h-full w-full items-center justify-center"
        style={{
          'background-color': '#0a0a0b',
          'border-radius': '9px',
          color: '#ededee',
        }}
      >
        <div style={{ width: `${markPct}%`, height: `${markPct}%` }}>
          <Mark size="optical" />
        </div>
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
