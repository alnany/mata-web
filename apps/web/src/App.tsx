import type { ParentProps } from 'solid-js';
import { createEffect, createSignal, onCleanup, onMount, Show, Switch, Match } from 'solid-js';
import { useNavigate, useLocation } from '@solidjs/router';
import { createMatrixBridge } from './bridge/worker-client.js';
import { BridgeContext } from './bridge/context.js';
import { session, setSession } from './stores/session.js';
import { ToastRoot } from './components/toast-root.js';
import { VerificationModal } from './components/verification-modal.js';
import { attachVerificationStore } from './stores/verification.js';
import { notifyTotals } from './stores/notifications.js';
import { initCallStore } from './stores/call.js';
import { CallOverlay } from './components/call-overlay.js';
import { Mark } from './components/logo.js';
// Side-effect: bootstrap the theme classes on <html> at app load.
import './stores/theme.js';
import type { MatrixBridge } from '@mata/shared/rpc';

export function App(props: ParentProps) {
  const [bridge, setBridge] = createSignal<MatrixBridge | null>(null);
  const [bootError, setBootError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const b = createMatrixBridge();
      const pong = await b.request({ kind: 'ping' });
      if (!pong.pong) throw new Error('Worker did not pong');
      setBridge(b);
      // Verification store listens globally — incoming SAS requests
      // from a paired device should pop the modal even if the user
      // never opened a Verify button in this tab.
      const detachVerify = attachVerificationStore(b);
      onCleanup(detachVerify);

      // Try to restore an existing session. The result drives routing.
      setSession({ phase: 'restoring' });
      const res = await b.request({ kind: 'restoreSession' });
      if (res.restored && res.userId && res.deviceId) {
        setSession({ phase: 'authenticated', userId: res.userId, deviceId: res.deviceId });
      } else {
        setSession({ phase: 'anonymous' });
      }
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
      setSession({ phase: 'anonymous' });
    }
  });

  onCleanup(() => {
    bridge()?.dispose();
  });

  // Phase 14 — bring up the call store as soon as we have both a
  // bridge AND a known MXID. We can't initialize earlier because the
  // store needs `myUserId` to route inbound signaling (we filter out
  // our own echoes by sender). Safe to re-run on session change; the
  // store deduplicates the internal `initialized` flag.
  createEffect(() => {
    const b = bridge();
    const s = session();
    if (!b) return;
    if (s.phase !== 'authenticated') return;
    initCallStore(b, s.userId);
  });

  // Tab title reflects unread / highlight tallies driven by the
  // notifications store. We pin the base title here (rather than in
  // index.html) so the reset path is unambiguous: tally = 0 → "Mata".
  // Highlights get a precedence prefix because they're the actionable
  // class of unread.
  const BASE_TITLE = 'Mata';
  createEffect(() => {
    const h = notifyTotals.highlights();
    const u = notifyTotals.unread();
    let next = BASE_TITLE;
    if (h > 0) next = `(${h}🔔) ${BASE_TITLE}`;
    else if (u > 0) next = `(${u}) ${BASE_TITLE}`;
    if (typeof document !== 'undefined' && document.title !== next) {
      document.title = next;
    }
  });

  return (
    <>
      <Switch>
        <Match when={bridge() && bootError() === null}>
          {/* biome-ignore lint/style/noNonNullAssertion: guarded by Match */}
          <BridgeContext.Provider value={bridge()!}>
            <SessionRouter>{props.children}</SessionRouter>
          </BridgeContext.Provider>
        </Match>
        <Match when={true}>
          <BootScreen
            error={bootError()}
            onRetry={() => {
              setBootError(null);
              window.location.reload();
            }}
          />
        </Match>
      </Switch>
      <ToastRoot />
      <Show when={bridge() && bootError() === null}>
        {/* biome-ignore lint/style/noNonNullAssertion: guarded by Show */}
        <BridgeContext.Provider value={bridge()!}>
          <VerificationModal />
          <CallOverlay />
        </BridgeContext.Provider>
      </Show>
    </>
  );
}

function SessionRouter(props: ParentProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Redirect on auth state transitions.
  const sync = () => {
    const s = session();
    if (s.phase === 'authenticated' && location.pathname === '/login') {
      navigate('/', { replace: true });
    } else if (s.phase === 'anonymous' && location.pathname !== '/login') {
      navigate('/login', { replace: true });
    }
  };

  onMount(sync);

  return (
    <Show when={session().phase !== 'restoring'} fallback={<RestoreScreen />}>
      {props.children}
    </Show>
  );
}

function RestoreScreen() {
  return (
    <div class="flex h-full w-full items-center justify-center bg-app p-8">
      <BrandedLoader label="Restoring session…" />
    </div>
  );
}

function BootScreen(props: { error: string | null; onRetry: () => void }) {
  return (
    <div class="flex h-full w-full items-center justify-center bg-app p-8">
      <div class="max-w-sm text-center">
        {/* Standalone mark — display optical tier per LOGO.md. */}
        <div class="mx-auto mb-5 h-12 w-12 text-fg">
          <Mark size="display" />
        </div>
        <div
          class="mb-1 text-[28px] leading-none text-fg"
          style={{ 'font-weight': 400, 'letter-spacing': '-0.06em' }}
        >
          mata
        </div>
        <div class="mono mb-6 text-[11px] uppercase tracking-[0.08em] text-fg-4">
          the eye of the day
        </div>
        <Show
          when={props.error}
          fallback={<BrandedLoader label="Starting worker…" />}
        >
          {(err) => (
            <div class="space-y-3">
              <div class="text-sm text-danger" aria-live="assertive">
                Worker failed to start: {err()}
              </div>
              <button
                type="button"
                onClick={props.onRetry}
                class="rounded-[7px] bg-accent px-3 py-2 text-[12px] font-medium text-accent-ink hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                Retry
              </button>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

/**
 * Branded loader — the e2ee pulse dot pattern (the design's only ambient
 * motion) gets repurposed as the boot indicator so loading screens feel
 * native to the rest of the product.
 */
function BrandedLoader(props: { label: string }) {
  return (
    <div class="flex items-center justify-center gap-2 text-fg-3" aria-live="polite">
      <span class="dot-accent mata-pulse" />
      <span class="mono text-[11px] uppercase tracking-[0.08em]">{props.label}</span>
    </div>
  );
}
