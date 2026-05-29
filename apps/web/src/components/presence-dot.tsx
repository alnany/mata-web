import { Show, createMemo, onMount } from 'solid-js';
import type { UserId } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { presenceOf, isOnline, ensurePresence } from '../stores/presence.js';

/**
 * Online indicator — a lime accent dot (the design system reserves
 * `.dot-accent` / accent-glow for presence). Renders ONLY when the user
 * is actively online; offline/away is conveyed by the "last seen" text
 * instead (Telegram pattern — no grey dot clutter).
 *
 * - `overlay` → absolute bottom-right corner badge for an avatar
 *   (the avatar wrapper must be `position: relative`).
 * - default → inline dot (e.g. beside a name in a header).
 */
export function PresenceDot(props: { userId: string; overlay?: boolean; corner?: 'br' | 'tr' }) {
  const bridge = useBridge();
  onMount(() => ensurePresence(bridge, props.userId as UserId));
  const online = createMemo(() => isOnline(presenceOf(props.userId)));
  return (
    <Show when={online()}>
      <span
        class="presence-dot"
        classList={{
          'presence-dot--overlay': !!props.overlay,
          'presence-dot--tr': props.overlay && props.corner === 'tr',
        }}
        title="online"
        aria-label="online"
      />
    </Show>
  );
}
