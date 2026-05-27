/**
 * Typed error taxonomy for the worker ↔ main thread boundary.
 *
 * Errors are serialized as plain objects across `postMessage` (Error instances
 * lose their prototype chain on structured clone), so consumers reconstruct
 * via `MataError.from(...)` if they need an Error instance.
 */

export type ErrorCategory =
  | 'network' // retryable, exponential backoff
  | 'auth' // non-retryable, force logout
  | 'rate_limit' // respect Retry-After
  | 'crypto' // surface to UI as "key issue"
  | 'server' // 5xx, retry once
  | 'protocol' // unexpected response shape, log loudly
  | 'storage' // IndexedDB quota or corruption
  | 'aborted' // user-cancelled
  | 'unknown';

export interface SerializedError {
  category: ErrorCategory;
  message: string;
  /** HTTP status if applicable. */
  status?: number;
  /** Matrix errcode (e.g. `M_FORBIDDEN`) if applicable. */
  matrixErrcode?: string;
  /** Server-suggested retry delay in ms. */
  retryAfterMs?: number;
  /** Whether the caller should attempt automatic retry. */
  retryable: boolean;
  /** Optional debug context. Never include secrets. */
  context?: Record<string, string | number | boolean | null>;
}

export class MataError extends Error {
  readonly category: ErrorCategory;
  readonly status: number | undefined;
  readonly matrixErrcode: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;
  readonly context: Record<string, string | number | boolean | null> | undefined;

  constructor(serialized: SerializedError) {
    super(serialized.message);
    this.name = 'MataError';
    this.category = serialized.category;
    this.status = serialized.status;
    this.matrixErrcode = serialized.matrixErrcode;
    this.retryAfterMs = serialized.retryAfterMs;
    this.retryable = serialized.retryable;
    this.context = serialized.context;
  }

  toJSON(): SerializedError {
    const out: SerializedError = {
      category: this.category,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.status !== undefined) out.status = this.status;
    if (this.matrixErrcode !== undefined) out.matrixErrcode = this.matrixErrcode;
    if (this.retryAfterMs !== undefined) out.retryAfterMs = this.retryAfterMs;
    if (this.context !== undefined) out.context = this.context;
    return out;
  }

  static from(serialized: SerializedError): MataError {
    return new MataError(serialized);
  }
}

export function networkError(message: string, status?: number): MataError {
  const init: SerializedError = { category: 'network', message, retryable: true };
  if (status !== undefined) init.status = status;
  return new MataError(init);
}

export function authError(message: string): MataError {
  return new MataError({ category: 'auth', message, retryable: false });
}

export function cryptoError(message: string, context?: SerializedError['context']): MataError {
  const init: SerializedError = { category: 'crypto', message, retryable: false };
  if (context !== undefined) init.context = context;
  return new MataError(init);
}

export function syncError(message: string): MataError {
  return new MataError({ category: 'protocol', message, retryable: false });
}

export function protocolError(message: string): MataError {
  return new MataError({ category: 'protocol', message, retryable: false });
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
