/**
 * Main-thread session signal. Holds the currently-restored identity (if any).
 * The actual credential material lives in the worker — this signal only
 * carries identifiers safe to render.
 */

import { createSignal } from 'solid-js';
import type { DeviceId, UserId } from '@mata/shared/matrix';

export type SessionState =
  | { phase: 'unknown' }
  | { phase: 'restoring' }
  | { phase: 'anonymous' }
  | { phase: 'authenticated'; userId: UserId; deviceId: DeviceId };

const [session, setSession] = createSignal<SessionState>({ phase: 'unknown' });

export { session, setSession };
