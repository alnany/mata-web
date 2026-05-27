import type { ParentProps } from 'solid-js';
import { createSignal, onCleanup, onMount, Show, Switch, Match } from 'solid-js';
import { useNavigate, useLocation } from '@solidjs/router';
import { createMatrixBridge } from './bridge/worker-client.js';
import { BridgeContext } from './bridge/context.js';
import { session, setSession } from './stores/session.js';
import { ToastRoot } from './components/toast-root.js';
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
    <div class="flex h-full w-full items-center justify-center p-8">
      <div class="text-sm text-neutral-500" aria-live="polite">
        Restoring session…
      </div>
    </div>
  );
}

function BootScreen(props: { error: string | null; onRetry: () => void }) {
  return (
    <div class="flex h-full w-full items-center justify-center p-8">
      <div class="max-w-sm text-center">
        <div class="mb-4 text-3xl font-semibold tracking-tight">Mata</div>
        <Show
          when={props.error}
          fallback={
            <div class="text-sm text-neutral-500" aria-live="polite">
              Starting worker…
            </div>
          }
        >
          {(err) => (
            <div class="space-y-3">
              <div class="text-sm text-red-600 dark:text-red-400" aria-live="assertive">
                Worker failed to start: {err()}
              </div>
              <button
                type="button"
                onClick={props.onRetry}
                class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-500 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
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
