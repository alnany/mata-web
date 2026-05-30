import '@testing-library/jest-dom/vitest';

// ── jsdom gaps ────────────────────────────────────────────────────────────
// jsdom ships no layout engine, so the scroll/observer APIs our components
// call during mount are undefined and throw. Stubbing them here (once) is
// what unlocks DOM-level component tests at all — without it every render()
// of a real Mata component blows up before we can assert anything. These are
// inert no-ops: they exist so mount doesn't crash, never to be asserted on.
if (typeof window !== 'undefined') {
  window.scrollTo = window.scrollTo ?? (() => {});
  window.requestAnimationFrame =
    window.requestAnimationFrame ?? ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number);
  window.cancelAnimationFrame = window.cancelAnimationFrame ?? ((id: number) => clearTimeout(id));
  window.matchMedia =
    window.matchMedia ??
    ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);

  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error – test shim
  window.IntersectionObserver = window.IntersectionObserver ?? NoopObserver;
  // @ts-expect-error – test shim
  window.ResizeObserver = window.ResizeObserver ?? NoopObserver;

  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
}
