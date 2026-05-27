import { createContext, useContext } from 'solid-js';
import type { MatrixBridge } from '@mata/shared/rpc';

export const BridgeContext = createContext<MatrixBridge>();

export function useBridge(): MatrixBridge {
  const ctx = useContext(BridgeContext);
  if (!ctx) {
    throw new Error('useBridge() must be called inside <BridgeContext.Provider>');
  }
  return ctx;
}
