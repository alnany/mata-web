import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for the Safari-only "Not logged in" class of bugs.
 *
 * The worker must NOT use a synchronous insta-throw client gate. Every
 * client-backed operation goes through the self-healing `waitForClient()`,
 * which tolerates the in-memory client being momentarily null — the
 * cold-boot race AND Safari/WebKit aggressively suspending and re-spinning
 * idle workers. A synchronous `requireClient()` that throws on the first
 * null tick is exactly what made `send` / `loadRoomHistory` fail on Safari
 * while Chrome (faster boot, no worker suspension) never saw it.
 *
 * If you reintroduce a synchronous gate, this test fails on purpose.
 */
// vitest runs with cwd = apps/web; the worker lives two levels up.
const sdkImpl = resolve(process.cwd(), '../../workers/matrix/src/sdk-impl.ts');

describe('worker client gate — Safari "Not logged in" regression guard', () => {
  const src = readFileSync(sdkImpl, 'utf8');

  it('has no synchronous requireClient() call sites', () => {
    const calls = src.match(/this\.requireClient\(\)/g) ?? [];
    expect(calls).toHaveLength(0);
  });

  it('does not declare a synchronous requireClient() gate method', () => {
    expect(/\brequireClient\s*\(\s*\)\s*:/.test(src)).toBe(false);
  });

  it('still routes client access through waitForClient()', () => {
    expect(src.includes('async waitForClient(')).toBe(true);
    expect((src.match(/this\.waitForClient\(\)/g) ?? []).length).toBeGreaterThan(20);
  });
});
