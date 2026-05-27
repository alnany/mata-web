import { describe, expect, it, expectTypeOf } from 'vitest';
import type {
  MainToWorkerRequest,
  MainToWorkerResponse,
  RequestEnvelope,
  ResponseEnvelope,
  ResponseFor,
} from './rpc-contract.js';

describe('rpc-contract type integrity', () => {
  it('every request kind has a matching response kind (1:1)', () => {
    type ReqKinds = MainToWorkerRequest['kind'];
    type ResKinds = MainToWorkerResponse['kind'];
    // If this line fails to compile, a request or response kind is unpaired.
    expectTypeOf<ReqKinds>().toEqualTypeOf<ResKinds>();
    expect(true).toBe(true);
  });

  it('ResponseFor selects the right response variant', () => {
    type LoginResp = ResponseFor<'login'>;
    expectTypeOf<LoginResp>().toMatchTypeOf<{
      kind: 'login';
      userId: string;
      deviceId: string;
    }>();
    expect(true).toBe(true);
  });

  it('RequestEnvelope structurally tags requests', () => {
    const env: RequestEnvelope = {
      type: 'request',
      id: 'rpc-1',
      payload: { kind: 'ping' },
    };
    expect(env.type).toBe('request');
    expect(env.payload.kind).toBe('ping');
  });

  it('ResponseEnvelope tags ok / error variants', () => {
    const ok: ResponseEnvelope = {
      type: 'response',
      id: 'rpc-1',
      ok: true,
      payload: { kind: 'ping', pong: true },
    };
    const err: ResponseEnvelope = {
      type: 'response',
      id: 'rpc-1',
      ok: false,
      error: { category: 'network', message: 'offline', retryable: true },
    };
    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
  });
});
