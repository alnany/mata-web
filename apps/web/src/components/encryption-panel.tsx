import { createResource, createSignal, Show } from 'solid-js';
import type { EncryptionStatus } from '@mata/shared/matrix';
import { useBridge } from '../bridge/context.js';
import { withToast } from '../stores/toast.js';

/**
 * Settings → Encryption panel. Two flows:
 *   1. Set up secure backup (cross-signing + SSSS + key backup) — the
 *      first-device path. Asks for the user's login password (UIA gate
 *      for /keys/device_signing/upload) and a security passphrase, then
 *      shows the generated recovery key once.
 *   2. Restore from recovery key — the new-device path. User enters
 *      either the base58 recovery key OR their security passphrase;
 *      worker decides which.
 *
 * Status block at the top reflects three independent flags
 * (cross-signing / secret storage / key backup). All-green only when
 * `recoveryReady`. We poll on panel mount and after each successful
 * mutation to keep the indicator honest.
 */
export function EncryptionPanel() {
  const bridge = useBridge();

  // Reactivity key: bumped after every successful mutation to force
  // re-fetch (createResource sources don't re-trigger on identical
  // values, so we use a counter rather than a boolean).
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [status] = createResource<EncryptionStatus, number>(
    refreshTick,
    async () => {
      const res = await bridge.request({ kind: 'getEncryptionStatus' });
      return res.status;
    },
  );

  const [mode, setMode] = createSignal<'idle' | 'setup' | 'restore' | 'done'>(
    'idle',
  );
  const [password, setPassword] = createSignal('');
  const [passphrase, setPassphrase] = createSignal('');
  const [confirmPassphrase, setConfirmPassphrase] = createSignal('');
  const [restoreInput, setRestoreInput] = createSignal('');
  const [recoveryKey, setRecoveryKey] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  function resetForm() {
    setPassword('');
    setPassphrase('');
    setConfirmPassphrase('');
    setRestoreInput('');
  }

  async function runSetup() {
    if (busy()) return;
    if (passphrase().length < 8) {
      window.alert('Security passphrase must be at least 8 characters.');
      return;
    }
    if (passphrase() !== confirmPassphrase()) {
      window.alert('Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await withToast(
        bridge.request({
          kind: 'enableKeyBackup',
          password: password(),
          passphrase: passphrase(),
        }),
        'Could not set up secure backup',
      );
      setRecoveryKey(res.recoveryKey);
      setMode('done');
      resetForm();
      setRefreshTick((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function runRestore() {
    if (busy()) return;
    if (!restoreInput().trim()) {
      window.alert('Enter your recovery key or security passphrase.');
      return;
    }
    setBusy(true);
    try {
      const res = await withToast(
        bridge.request({
          kind: 'restoreKeyBackup',
          recoveryKey: restoreInput().trim(),
        }),
        'Could not restore from recovery key',
      );
      window.alert(
        res.keysImported > 0
          ? `Restoring ${res.keysImported} room keys. Past encrypted messages will decrypt as keys download.`
          : 'Restore initiated. No keys to import from this device.',
      );
      setMode('idle');
      resetForm();
      setRefreshTick((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="space-y-4">
      {/* Status block */}
      <Show
        when={!status.loading}
        fallback={<div class="text-sm text-neutral-500">Loading…</div>}
      >
        <div class="rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
          <StatusRow
            label="Cross-signing"
            ok={status()?.crossSigningReady ?? false}
            hint="Master / self-signing / user-signing keys signed and uploaded."
          />
          <StatusRow
            label="Secret storage"
            ok={status()?.secretStorageReady ?? false}
            hint="Encrypted backup of cross-signing keys stored on the server."
          />
          <StatusRow
            label="Key backup"
            ok={status()?.keyBackupEnabled ?? false}
            hint={
              status()?.keyBackupVersion
                ? `Version ${status()?.keyBackupVersion} active.`
                : 'Server-side encrypted room-key backup.'
            }
          />
        </div>
      </Show>

      {/* Actions */}
      <Show when={mode() === 'idle'}>
        <Show
          when={status()?.recoveryReady}
          fallback={
            <div class="space-y-2">
              <button
                type="button"
                onClick={() => setMode('setup')}
                class="w-full rounded-lg border border-mata-300 bg-mata-50 px-4 py-2 text-sm font-medium text-mata-700 transition-colors hover:bg-mata-100 dark:border-mata-700 dark:bg-mata-950/40 dark:text-mata-300 dark:hover:bg-mata-950/60"
              >
                Set up secure backup
              </button>
              <button
                type="button"
                onClick={() => setMode('restore')}
                class="w-full rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
              >
                Restore from recovery key
              </button>
              <p class="text-[11px] text-neutral-500">
                Set up backup on your first device. On any new device, use
                Restore to re-trust this device and recover past room keys.
              </p>
            </div>
          }
        >
          <div class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            Secure backup is active. New encrypted messages are backed up to
            the server and recoverable on other devices with your recovery key.
          </div>
        </Show>
      </Show>

      {/* Setup form */}
      <Show when={mode() === 'setup'}>
        <div class="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <h3 class="text-sm font-semibold">Set up secure backup</h3>
          <p class="text-[12px] text-neutral-500">
            Your login password unlocks signing your device keys. Your
            security passphrase encrypts your key backup — you'll need it
            (or the printed recovery key) on any new device.
          </p>
          <FormField label="Login password">
            <input
              type="password"
              autocomplete="current-password"
              class="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </FormField>
          <FormField label="Security passphrase (new — pick something you'll remember)">
            <input
              type="password"
              autocomplete="new-password"
              class="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              value={passphrase()}
              onInput={(e) => setPassphrase(e.currentTarget.value)}
            />
          </FormField>
          <FormField label="Confirm passphrase">
            <input
              type="password"
              autocomplete="new-password"
              class="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              value={confirmPassphrase()}
              onInput={(e) => setConfirmPassphrase(e.currentTarget.value)}
            />
          </FormField>
          <div class="flex gap-2 pt-1">
            <button
              type="button"
              onClick={runSetup}
              disabled={busy()}
              class="flex-1 rounded-md bg-mata-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-mata-600 disabled:opacity-60"
            >
              {busy() ? 'Setting up…' : 'Set up backup'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                resetForm();
              }}
              disabled={busy()}
              class="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      {/* Done — show the recovery key once */}
      <Show when={mode() === 'done' && recoveryKey()}>
        <div class="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <h3 class="text-sm font-semibold">Save your recovery key</h3>
          <p class="text-[12px]">
            Write this down or store it in a password manager. It's the
            offline escape hatch — if you forget your security passphrase,
            this is the only way back to your encrypted history.
          </p>
          <div
            class="select-all break-all rounded-md bg-white p-3 font-mono text-xs leading-relaxed text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
            onClick={(e) => {
              // Select all on click for easy copy.
              const range = document.createRange();
              range.selectNodeContents(e.currentTarget);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            }}
          >
            {recoveryKey()}
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                const k = recoveryKey();
                if (k) await navigator.clipboard.writeText(k);
              }}
              class="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-neutral-950 dark:text-amber-300 dark:hover:bg-neutral-900"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                setRecoveryKey(null);
              }}
              class="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600"
            >
              I saved it
            </button>
          </div>
        </div>
      </Show>

      {/* Restore form */}
      <Show when={mode() === 'restore'}>
        <div class="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <h3 class="text-sm font-semibold">Restore from recovery key</h3>
          <p class="text-[12px] text-neutral-500">
            Enter either your recovery key (the base58 string from setup)
            or your security passphrase. We'll re-trust this device and
            start importing past room keys.
          </p>
          <FormField label="Recovery key or passphrase">
            <textarea
              class="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
              rows={3}
              value={restoreInput()}
              onInput={(e) => setRestoreInput(e.currentTarget.value)}
            />
          </FormField>
          <div class="flex gap-2 pt-1">
            <button
              type="button"
              onClick={runRestore}
              disabled={busy()}
              class="flex-1 rounded-md bg-mata-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-mata-600 disabled:opacity-60"
            >
              {busy() ? 'Restoring…' : 'Restore'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('idle');
                resetForm();
              }}
              disabled={busy()}
              class="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function StatusRow(props: { label: string; ok: boolean; hint: string }) {
  return (
    <div class="flex items-start gap-2 py-1.5">
      <span
        class={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white ${
          props.ok ? 'bg-emerald-500' : 'bg-neutral-400 dark:bg-neutral-600'
        }`}
        aria-label={props.ok ? 'ready' : 'not ready'}
      >
        {props.ok ? '✓' : '·'}
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">{props.label}</div>
        <div class="text-[11px] text-neutral-500">{props.hint}</div>
      </div>
    </div>
  );
}

function FormField(props: { label: string; children: import('solid-js').JSX.Element }) {
  return (
    <label class="block space-y-1">
      <span class="block text-[11px] font-medium text-neutral-600 dark:text-neutral-400">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}
