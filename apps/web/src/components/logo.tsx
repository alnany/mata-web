/**
 * Mata brand surface.
 *
 * `<Mark>` is the standalone ring+bar SVG — single source of truth
 * for the logo (favicon, splash, boot screen, login, anywhere a non-
 * rail mark appears). The old `<BrandSquare>` workspace-rail tile
 * was removed when the single-account redesign dropped the rail
 * column entirely; if a rail ever returns, regenerate the tile from
 * the design skill (`LOGO.md §"App icon"`) rather than reviving the
 * dead export here.
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

