/**
 * Rich-text bridge between the composer's markdown and Matrix's
 * `org.matrix.custom.html` (`formatted_body`).
 *
 * Two independent concerns live here:
 *
 *   1. `markdownToMatrixHtml(plain)` — OUTBOUND. Converts a small,
 *      Telegram-compatible markdown subset to a safe HTML string for
 *      `formatted_body`. Returns `null` when the text carries no
 *      formatting, so callers only attach `formatted_body` when it
 *      actually differs from the plaintext `body`.
 *
 *   2. `sanitizeMatrixHtml(html)` — INBOUND. Allowlist sanitizer that
 *      takes arbitrary `formatted_body` from any homeserver/client and
 *      returns an HTML string safe to assign via `innerHTML`. This is
 *      the ONLY place untrusted HTML is allowed near the DOM, so the
 *      allowlist is deliberately tight: no scripts, no inline styles,
 *      no event handlers, no `javascript:` URLs, no `<img>`.
 *
 * Security note: the sanitizer parses into a detached document
 * (`DOMParser`) and rebuilds an allowed-only subtree. Anything not on
 * the allowlist is dropped (the element) or unwrapped (children kept).
 * We never trust attributes — each is re-validated by name + value.
 */

// ---------------------------------------------------------------------------
// OUTBOUND: markdown -> Matrix custom HTML
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Convert the supported markdown subset to HTML. Returns null when the
 * result is identical to the escaped plaintext (i.e. nothing to format),
 * letting the caller skip `formatted_body` entirely.
 *
 * Supported:
 *   - fenced code blocks  ```\n…\n```        -> <pre><code>…</code></pre>
 *   - inline code         `code`             -> <code>code</code>
 *   - bold                **x**  __x__       -> <strong>
 *   - italic              *x*  _x_           -> <em>
 *   - strikethrough       ~~x~~              -> <del>
 *   - blockquote          > line             -> <blockquote>
 *   - bare links          https://…          -> <a href>
 *   - newlines                               -> <br> (outside code)
 *
 * Code spans/blocks are extracted to placeholders BEFORE inline
 * emphasis runs, so `**not bold inside code**` stays literal.
 */
export function markdownToMatrixHtml(plain: string): string | null {
  if (!plain) return null;

  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  // 1. Pull out fenced code blocks first so their content is verbatim.
  let work = plain.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/^\n/, '').replace(/\n$/, ''))}</code></pre>`);
    return `\u0000CB${idx}\u0000`;
  });

  // 2. Pull out inline code spans.
  work = work.replace(/`([^`\n]+?)`/g, (_m, code: string) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000IC${idx}\u0000`;
  });

  // 3. Escape the remaining text — emphasis markers are plain ASCII so
  //    they survive escaping untouched.
  work = escapeHtml(work);

  // 4. Inline emphasis. Order matters: bold (double) before italic
  //    (single) so `**x**` isn't eaten as two italics.
  work = work
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^\n]+?)__/g, '<strong>$1</strong>')
    .replace(/~~([^\n]+?)~~/g, '<del>$1</del>')
    // italic: single * or _ not adjacent to another of the same marker
    .replace(/(^|[^\*])\*([^\*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');

  // 5. Bare-URL autolink (avoid matching inside an already-built tag by
  //    only linking runs that start at a boundary). Trailing sentence
  //    punctuation is excluded from the href.
  work = work.replace(
    /(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+[^\s<.,!?)\]])/g,
    (_m, pre: string, url: string) => {
      const href = url.startsWith('www.') ? `https://${url}` : url;
      return `${pre}<a href="${href}">${url}</a>`;
    },
  );

  // 6. Blockquotes: consecutive `> ` lines collapse into one block.
  const lines = work.split('\n');
  const out: string[] = [];
  let quote: string[] | null = null;
  const flushQuote = () => {
    if (quote) {
      out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      quote = null;
    }
  };
  for (const line of lines) {
    const m = /^&gt;\s?(.*)$/.exec(line);
    if (m) {
      (quote ??= []).push(m[1]);
    } else {
      flushQuote();
      out.push(line);
    }
  }
  flushQuote();
  work = out.join('\n');

  // 7. Newlines -> <br>, but not immediately around block elements.
  work = work
    .replace(/\n/g, '<br>')
    .replace(/<br>(<\/?(?:blockquote|pre)>)/g, '$1')
    .replace(/(<\/?(?:blockquote|pre)>)<br>/g, '$1');

  // 8. Restore code placeholders.
  work = work
    .replace(/\u0000IC(\d+)\u0000/g, (_m, i: string) => inlineCode[Number(i)] ?? '')
    .replace(/\u0000CB(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? '');

  // No formatting introduced -> plaintext is sufficient.
  const plainEscaped = escapeHtml(plain).replace(/\n/g, '<br>');
  if (work === plainEscaped) return null;
  return work;
}

// ---------------------------------------------------------------------------
// INBOUND: sanitize untrusted Matrix custom HTML
// ---------------------------------------------------------------------------

// Tag allowlist (lowercase). Matrix-recommended subset minus anything
// that needs media resolution or carries layout/scripting risk.
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'code', 'pre',
  'blockquote', 'br', 'p', 'a', 'ul', 'ol', 'li', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'sup', 'sub',
]);

const SAFE_URL = /^(https?:|mailto:|matrix:|#)/i;

const cleanHref = (raw: string): string | null => {
  const v = raw.trim();
  // Block control chars that smuggle `javascript:` past the regex.
  if (/[\u0000-\u001f]/.test(v)) return null;
  return SAFE_URL.test(v) ? v : null;
};

/**
 * Rebuild `node`'s children into `parent` (a node in the output doc),
 * keeping only allowlisted elements/attributes and text. Disallowed
 * elements are unwrapped (their safe children are kept) so content is
 * never silently lost — except for `<script>`/`<style>` whose entire
 * subtree is dropped.
 */
function rebuild(src: Node, dest: Node, doc: Document, depth: number): void {
  if (depth > 100) return; // pathological nesting guard
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      dest.appendChild(doc.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object') {
      continue; // drop element AND subtree
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: keep sanitized children, discard the wrapper.
      rebuild(el, dest, doc, depth + 1);
      continue;
    }

    const safe = doc.createElement(tag);
    if (tag === 'a') {
      const href = el.getAttribute('href');
      const clean = href ? cleanHref(href) : null;
      if (clean) {
        safe.setAttribute('href', clean);
        safe.setAttribute('rel', 'noopener noreferrer nofollow');
        safe.setAttribute('target', '_blank');
      }
    } else if (tag === 'span') {
      // Only the spoiler marker survives; everything else is dropped.
      if (el.hasAttribute('data-mx-spoiler')) {
        safe.setAttribute('data-mx-spoiler', '');
      }
    }
    rebuild(el, safe, doc, depth + 1);
    dest.appendChild(safe);
  }
}

/**
 * Sanitize an untrusted `formatted_body` HTML string into a safe HTML
 * string for `innerHTML`. Returns '' for empty/invalid input.
 */
export function sanitizeMatrixHtml(html: string): string {
  if (!html) return '';
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return '';
  }
  const out = doc.implementation.createHTMLDocument('');
  const container = out.createElement('div');
  rebuild(doc.body, container, out, 0);
  return container.innerHTML;
}
