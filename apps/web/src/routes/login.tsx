import { createSignal, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useBridge } from '../bridge/context.js';
import { setSession } from '../stores/session.js';
import { Mark } from '../components/logo.js';

const DEFAULT_HOMESERVER = 'https://matrix.org';
const HOMESERVER_LS_KEY = 'mata.lastHomeserver';

/**
 * Remembers the last successful homeserver URL the user typed. We do
 * NOT remember credentials — only the server URL, so power users who
 * type `https://chat.greatass.me` every time get it back on reload.
 */
function loadRememberedHomeserver(): string {
  try {
    const v = localStorage.getItem(HOMESERVER_LS_KEY);
    if (v && typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  } catch {
    /* localStorage may be disabled */
  }
  return DEFAULT_HOMESERVER;
}

export function LoginPage() {
  const bridge = useBridge();
  const navigate = useNavigate();
  const [homeserver, setHomeserver] = createSignal(loadRememberedHomeserver());
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const onSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (submitting()) return;
    setError(null);
    setSubmitting(true);
    try {
      const normalized = normalizeServer(homeserver());
      const result = await bridge.request({
        kind: 'login',
        serverUrl: normalized,
        user: username().trim(),
        password: password(),
        deviceDisplayName: deriveDeviceName(),
      });
      console.log('[mata-login] success', result);
      // Persist the homeserver URL only on successful login — so a
      // typo'd URL doesn't get stuck across reloads.
      try {
        localStorage.setItem(HOMESERVER_LS_KEY, normalized);
      } catch {
        /* localStorage may be disabled */
      }
      setSession({
        phase: 'authenticated',
        userId: result.userId,
        deviceId: result.deviceId,
      });
      navigate('/', { replace: true });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error('[mata-login] failed', { err });
      setError(raw || 'Sign-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main class="flex h-full w-full items-center justify-center bg-app p-6">
      <form
        onSubmit={onSubmit}
        class="w-full max-w-sm space-y-5 rounded-[14px] border bg-elev p-8"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        <header class="flex items-center gap-3">
          {/* Standalone mark — display tier (32px container). Color
              inherits via currentColor so the ring picks up `text-fg`. */}
          <div class="h-8 w-8 shrink-0 text-fg">
            <Mark size="display" />
          </div>
          <div class="space-y-0.5">
            <div
              class="text-[19px] leading-none text-fg"
              style={{ 'font-weight': 500, 'letter-spacing': '-0.025em' }}
            >
              mata
            </div>
            <div class="mono text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
              sign in
            </div>
          </div>
        </header>

        <p class="text-[12.5px] leading-snug text-fg-3">
          Bring your own homeserver. Mata is the client, never the host.
        </p>

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
              class="rounded-[6px] border px-3 py-2 text-[12px] text-danger"
              style={{ 'border-color': 'color-mix(in oklab, var(--color-danger) 35%, transparent)', background: 'color-mix(in oklab, var(--color-danger) 8%, transparent)' }}
            >
              {msg()}
            </div>
          )}
        </Show>

        <button
          type="submit"
          disabled={submitting()}
          class="flex h-[34px] w-full items-center justify-center gap-2 rounded-[7px] bg-accent text-[12px] font-medium text-accent-ink transition-[filter] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span>{submitting() ? 'Signing in…' : 'Sign in'}</span>
          <span
            class="mono rounded-[4px] px-1 py-[1px] text-[10px]"
            style={{ background: 'rgba(0,0,0,0.18)' }}
          >
            ⌘↩
          </span>
        </button>

        <div class="flex items-center justify-center gap-2 pt-1 text-fg-4">
          <span class="dot-accent mata-pulse" />
          <span class="mono text-[10.5px] uppercase tracking-[0.08em]">
            encrypted, end to end
          </span>
        </div>
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
    <label class="block space-y-1.5">
      <span class="mono block text-[10.5px] uppercase tracking-[0.08em] text-fg-4">
        {props.label}
      </span>
      <input
        type={props.type}
        name={props.name}
        value={props.value}
        required={props.required}
        placeholder={props.placeholder}
        autocomplete={props.autocomplete}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        class="w-full rounded-[8px] border bg-input px-3 py-2 text-[14px] text-fg placeholder:text-fg-4 focus:outline-none"
        style={{ 'border-color': 'var(--color-line)' }}
        onFocus={(e) => e.currentTarget.style.borderColor = 'var(--color-line-2)'}
        onBlur={(e) => e.currentTarget.style.borderColor = 'var(--color-line)'}
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
