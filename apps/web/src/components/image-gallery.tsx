import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { EventId, MediaMessageBody } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';

type Bridge = ReturnType<typeof useBridge>;

export interface GalleryImage {
  eventId: EventId;
  body: MediaMessageBody;
  name: string;
}

/** Replicates MediaContent's loadMedia call; the worker caches blobs. */
async function loadImageUrl(bridge: Bridge, body: MediaMessageBody): Promise<string> {
  const mxc = body.file?.url ?? body.url;
  if (!mxc) throw new Error('no mxc URI on event');
  const ef = body.file
    ? {
        v: 'v2' as const,
        url: body.file.url,
        key: {
          kty: 'oct' as const,
          alg: 'A256CTR' as const,
          key_ops: ['encrypt', 'decrypt'] as ['encrypt', 'decrypt'],
          k: body.file.key.k,
          ext: true as const,
        },
        iv: body.file.iv,
        hashes: { sha256: body.file.hashes.sha256 },
      }
    : null;
  const res = await bridge.request({
    kind: 'loadMedia',
    mxc,
    encryptedFile: ef,
    mime: body.info.mimetype,
  });
  return URL.createObjectURL(new Blob([res.data], { type: res.mime }));
}

/**
 * Room-level image album. Opens on the clicked image and lets the user
 * page through every image in the room with the on-screen chevrons, the
 * ←/→ arrow keys, or a swipe. Backdrop-click / Esc / the ✕ closes it.
 */
export function ImageGallery(props: {
  images: GalleryImage[];
  startEventId: EventId;
  onClose: () => void;
}) {
  const bridge = useBridge();
  const startIdx = Math.max(
    0,
    props.images.findIndex((i) => i.eventId === props.startEventId),
  );
  const [idx, setIdx] = createSignal(startIdx);
  const count = () => props.images.length;
  const current = () => props.images[idx()];
  const prev = () => setIdx((i) => (i - 1 + count()) % count());
  const next = () => setIdx((i) => (i + 1) % count());

  const [url] = createResource(
    () => current()?.body,
    (body) => loadImageUrl(bridge, body),
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  // Revoke object URLs as we move on, so paging a large album doesn't
  // leak a blob per image.
  let lastUrl: string | undefined;
  createEffect(() => {
    const u = url();
    if (lastUrl && lastUrl !== u) URL.revokeObjectURL(lastUrl);
    lastUrl = u ?? undefined;
  });
  onCleanup(() => {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
  });

  // Touch swipe.
  let touchX: number | null = null;
  const onTouchStart = (e: TouchEvent) => {
    touchX = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (touchX === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX;
    if (Math.abs(dx) > 50) (dx > 0 ? prev : next)();
    touchX = null;
  };

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-6 backdrop-blur-sm"
        onClick={props.onClose}
        role="dialog"
        aria-label="Image gallery"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Counter */}
        <Show when={count() > 1}>
          <div class="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">
            {idx() + 1} / {count()}
          </div>
        </Show>

        {/* Image */}
        <Show
          when={url()}
          fallback={<div class="text-sm text-white/70">{url.loading ? 'Loading…' : 'Unavailable'}</div>}
        >
          {(u) => (
            <img
              src={u()}
              alt={current()?.name ?? ''}
              class="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </Show>

        {/* Prev / Next */}
        <Show when={count() > 1}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            class="absolute left-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20"
            aria-label="Previous (←)"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 18L9 12L15 6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            class="absolute right-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors hover:bg-white/20"
            aria-label="Next (→)"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 18L15 12L9 6" />
            </svg>
          </button>
        </Show>

        {/* Close */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
          class="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm hover:bg-white/20"
          aria-label="Close (Esc)"
          title="Close (Esc)"
        >
          ✕
        </button>

        {/* Download */}
        <Show when={url()}>
          {(u) => (
            <a
              href={u()}
              download={current()?.name ?? 'image'}
              onClick={(e) => e.stopPropagation()}
              class="absolute bottom-4 right-4 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-white/20"
              title="Download"
            >
              Download
            </a>
          )}
        </Show>
      </div>
    </Portal>
  );
}
