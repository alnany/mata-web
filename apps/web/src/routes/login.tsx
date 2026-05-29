import { createSignal, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useBridge } from '../bridge/context.js';
import { setSession } from '../stores/session.js';
import { Mark } from '../components/logo.js';

const DEFAULT_HOMESERVER = 'https://matrix.org';
const HOMESERVER_LS_KEY = 'mata.lastHomeserver';

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

  // Shared state
  const [tab, setTab] = createSignal<'signin' | 'register'>('signin');
  const [homeserver, setHomeserver] = createSignal(loadRememberedHomeserver());
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Register-only state
  const [confirmPassword, setConfirmPassword] = createSignal('');

  const resetForm = (nextTab: 'signin' | 'register') => {
    setTab(nextTab);
    setError(null);
    setUsername('');
    setPassword('');
    setConfirmPassword('');
  };

  // ── Sign-in ──────────────────────────────────────────────────────────────
  const onSignIn = async (e: SubmitEvent) => {
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
      setError(raw || 'Sign-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Register ─────────────────────────────────────────────────────────────
  // Registration calls the homeserver directly from the UI thread — no
  // need to involve the Matrix worker because registration is a one-shot
  // unauthenticated HTTP call. On success, we auto-log-in via the bridge
  // using the freshly-created credentials.
  const onRegister = async (e: SubmitEvent) => {
    e.preventDefault();
    if (submitting()) return;
    setError(null);

    if (password() !== confirmPassword()) {
      setError('Passwords do not match');
      return;
    }
    if (password().length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setSubmitting(true);
    const normalized = normalizeServer(homeserver());
    const localpart = username().trim().replace(/^@/, '').split(':')[0];

    try {
      // Step 1: probe the available auth flows (unauthenticated GET).
      const flowsRes = await fetch(`${normalized}/_matrix/client/v3/register`, {
        method: 'GET',
      });
      // Step 2: try m.login.dummy first (works on Synapse with open registration).
      const body = {
        username: localpart,
        password: password(),
        auth: { type: 'm.login.dummy' },
        inhibit_login: false,
      };
      const res = await fetch(`${normalized}/_matrix/client/v3/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        // Server returned interactive auth session — check flows
        const uiaBody = await res.json() as {
          flows?: Array<{ stages: string[] }>;
          session?: string;
          error?: string;
        };
        const stages = uiaBody.flows?.flatMap((f) => f.stages) ?? [];
        const needsEmail = stages.includes('m.login.email.identity');
        const needsCaptcha = stages.includes('m.login.recaptcha');
        if (needsEmail || needsCaptcha) {
          setError(
            "This server requires " +
            (needsEmail ? 'email verification' : 'CAPTCHA') +
            ". Register via Element or your server's web interface, then sign in here.",
          );
          return;
        }
        // Retry with the session id
        const session = uiaBody.session ?? '';
        const retryBody = { ...body, auth: { type: 'm.login.dummy', session } };
        const retry = await fetch(`${normalized}/_matrix/client/v3/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(retryBody),
        });
        if (!retry.ok) {
          const errBody = await retry.json() as { error?: string };
          throw new Error(errBody.error ?? `Registration failed (${retry.status})`);
        }
        // fall through — retry succeeded
        const retryData = await retry.json() as { user_id?: string };
        void retryData; // we'll just log in below
      } else if (!res.ok) {
        const errBody = await res.json() as { error?: string };
        throw new Error(errBody.error ?? `Registration failed (${res.status})`);
      }

      // Step 3: auto-login with the new account
      try {
        localStorage.setItem(HOMESERVER_LS_KEY, normalized);
      } catch {
        /* localStorage may be disabled */
      }
      const loginResult = await bridge.request({
        kind: 'login',
        serverUrl: normalized,
        user: localpart,
        password: password(),
        deviceDisplayName: deriveDeviceName(),
      });
      setSession({
        phase: 'authenticated',
        userId: loginResult.userId,
        deviceId: loginResult.deviceId,
      });
      navigate('/', { replace: true });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(raw || 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  const isSignIn = () => tab() === 'signin';

  return (
    <main class="flex h-full w-full items-center justify-center bg-app p-6">
      <div
        class="w-full max-w-sm space-y-5 rounded-[14px] border bg-elev p-8"
        style={{ 'border-color': 'var(--color-line)' }}
      >
        {/* Logo */}
        <header class="flex items-center gap-3">
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
              {isSignIn() ? 'sign in' : 'create account'}
            </div>
          </div>
        </header>

        {/* Tab switcher */}
        <div
          class="flex gap-0 rounded-[8px] p-0.5 text-[12px]"
          style={{ background: 'var(--color-app)' }}
        >
          <button
            type="button"
            onClick={() => resetForm('signin')}
            class={`flex-1 rounded-[6px] py-1.5 font-medium transition-colors ${
              isSignIn()
                ? 'bg-elev text-fg shadow-sm'
                : 'text-fg-3 hover:text-fg'
            }`}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => resetForm('register')}
            class={`flex-1 rounded-[6px] py-1.5 font-medium transition-colors ${
              !isSignIn()
                ? 'bg-elev text-fg shadow-sm'
                : 'text-fg-3 hover:text-fg'
            }`}
          >
            Create account
          </button>
        </div>

        <Show when={isSignIn()}>
          <p class="text-[12.5px] leading-snug text-fg-3">
            Bring your own homeserver. Mata is the client, never the host.
          </p>
        </Show>
        <Show when={!isSignIn()}>
          <p class="text-[12.5px] leading-snug text-fg-3">
            Register a new account on your Matrix server.
          </p>
        </Show>

        {/* Sign-in form */}
        <Show when={isSignIn()}>
          <form onSubmit={onSignIn} class="space-y-4">
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

            <ErrorBox error={error()} />

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
        </Show>

        {/* Register form */}
        <Show when={!isSignIn()}>
          <form onSubmit={onRegister} class="space-y-4">
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
              placeholder="alice"
              autocomplete="username"
            />
            <Field
              label="Password"
              name="password"
              type="password"
              value={password()}
              onInput={setPassword}
              required
              autocomplete="new-password"
            />
            <Field
              label="Confirm password"
              name="confirm-password"
              type="password"
              value={confirmPassword()}
              onInput={setConfirmPassword}
              required
              autocomplete="new-password"
            />

            <ErrorBox error={error()} />

            <button
              type="submit"
              disabled={submitting()}
              class="flex h-[34px] w-full items-center justify-center gap-2 rounded-[7px] bg-accent text-[12px] font-medium text-accent-ink transition-[filter] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>{submitting() ? 'Creating account…' : 'Create account'}</span>
            </button>

            <p class="text-center text-[11.5px] text-fg-4">
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => resetForm('signin')}
                class="text-fg-3 underline underline-offset-2 hover:text-fg"
              >
                Sign in
              </button>
            </p>
          </form>
        </Show>
      </div>
    </main>
  );
}

// ── Shared sub-components ────────────────────────────────────────────────────

function ErrorBox(props: { error: string | null }) {
  return (
    <Show when={props.error}>
      {(msg) => (
        <div
          role="alert"
          class="rounded-[6px] border px-3 py-2 text-[12px] text-danger"
          style={{
            'border-color': 'color-mix(in oklab, var(--color-danger) 35%, transparent)',
            background: 'color-mix(in oklab, var(--color-danger) 8%, transparent)',
          }}
        >
          {msg()}
        </div>
      )}
    </Show>
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
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--color-line-2)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--color-line)')}
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
