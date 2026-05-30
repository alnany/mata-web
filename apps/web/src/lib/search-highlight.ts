// =============================================================================
// search-highlight.ts — split a body string into matched / unmatched runs so
// the search panel can bold the term the user typed. Pure + case-insensitive,
// matches every occurrence, and never mangles the original text (segments
// concatenate back to the input exactly).
// =============================================================================

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into alternating non-match / match segments against `query`
 * (case-insensitive, all occurrences). Concatenating `seg.text` in order
 * reproduces `text` verbatim. An empty/whitespace query yields a single
 * non-match segment (the whole string).
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = query.trim();
  if (!q || !text) return text ? [{ text, match: false }] : [];
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: HighlightSegment[] = [];
  let from = 0;
  let idx = hay.indexOf(needle, from);
  while (idx !== -1) {
    if (idx > from) out.push({ text: text.slice(from, idx), match: false });
    out.push({ text: text.slice(idx, idx + needle.length), match: true });
    from = idx + needle.length;
    idx = hay.indexOf(needle, from);
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false });
  return out;
}
