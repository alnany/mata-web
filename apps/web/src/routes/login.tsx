import { createSignal, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useBridge } from '../bridge/context.js';
import { setSession } from '../stores/session.js';

const DEFAULT_HOMESERVER = 'https://matrix.org';

// Persistent visible diagnostic banner — overlays bottom of viewport.
// Survives Solid re-renders and SessionRouter navigations because it's
// attached directly to document.body, not part of the component tree.
function paintDiag(msg: string) {
  try {
    let el = document.getElementById('mata-login-diag');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mata-login-diag';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'assertive');
      el.style.cssText = [
        'position:fixed',
        'bottom:0',
        'left:0',
        'right:0',
        'z-index:99999',
        'background:#111',
        'color:#fff',
        'font:12px/1.4 ui-monospace,Menlo,monospace',
        'padding:8px 12px',
        'border-top:2px solid #ff0',
        'white-space:pre-wrap',
        'word-break:break-all',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = `[${new Date().toISOString()}] ${msg}`;
  } catch {
    /* noop */
  }
}

export function LoginPage() {
  const bridge = useBridge();
  const navigate = useNavigate();
  const [homeserver, setHomeserver] = createSignal(DEFAULT_HOMESERVER);
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const onSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (submitting()) return;
    setError(null);
    setSubmitting(true);
    paintDiag(`onSubmit fired hs=${homeserver()} user=${username()}`);
    try {
      const result = await bridge.request({
        kind: 'login',
        serverUrl: normalizeServer(homeserver()),
        user: username().trim(),
        password: password(),
        deviceDisplayName: deriveDeviceName(),
      });
      document.title = `LOGIN_OK: ${result.userId} dev=${result.deviceId}`;
      console.log('[mata-login] success', result);
      paintDiag(`LOGIN_OK: ${result.userId} device=${result.deviceId}`);
      setSession({
        phase: 'authenticated',
        userId: result.userId,
        deviceId: result.deviceId,
      });
      navigate('/', { replace: true });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : '';
      const detail = raw || (err && typeof err === 'object' ? JSON.stringify(err) : '<empty error>');
      // Surface the failure aggressively — visible AND machine-readable from title.
      document.title = `LOGIN_ERR: ${detail}`;
      console.error('[mata-login] failed', { err, raw, stack });
      paintDiag(`LOGIN_ERR: ${detail}${stack ? ' // ' + stack : ''}`);
      setError(`${detail}${stack ? ` // ${stack}` : ''}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main class="flex h-full w-full items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        class="w-full max-w-sm space-y-4 rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <header class="space-y-1">
          <h1 class="text-2xl font-semibold tracking-tight">Sign in to Mata</h1>
          <p class="text-xs text-neutral-500 dark:text-neutral-400">
            Bring your own homeserver. Mata is the client, never the host.
          </p>
        </header>

        <Field
          label="Homeserver"
          name="homeserver"
          type="url"
          value={homeserver()}
          onInput={setHomeserver}
          required
          autocomplete="url"
        />
        <Field
          label="Username"
          name="username"
          type="text"
          value={username()}
          onInput={setUsername}
          required
          placeholder="alice or @alice:matrix.org"
          autocomplete="username"
        />
        <Field
          label="Password"
          name="password"
          type="password"
          value={password()}
          onInput={setPassword}
          required
          autocomplete="current-password"
        />

        <Show when={error()}>
          {(msg) => (
            <div
              role="alert"
              class="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200"
            >
              {msg()}
            </div>
          )}
        </Show>

        <button
          type="submit"
          disabled={submitting()}
          class="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {submitting() ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

interface FieldProps {
  label: string;
  name: string;
  type: 'text' | 'password' | 'url';
  value: string;
  onInput: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  autocomplete?: string;
}

function Field(props: FieldProps) {
  return (
    <label class="block space-y-1">
      <span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">{props.label}</span>
      <input
        type={props.type}
        name={props.name}
        value={props.value}
        required={props.required}
        placeholder={props.placeholder}
        autocomplete={props.autocomplete}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        class="w-full rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm shadow-inner focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:focus:border-neutral-600 dark:focus:ring-neutral-600"
      />
    </label>
  );
}

function normalizeServer(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_HOMESERVER;
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `https://${trimmed.replace(/\/+$/, '')}`;
}

function deriveDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox/.test(ua)
    ? 'Firefox'
    : /Edg/.test(ua)
      ? 'Edge'
      : /Chrome/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'Browser';
  return `Mata (${browser})`;
}
