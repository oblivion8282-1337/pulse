/**
 * Frontend WebSocket op → handler registry.
 *
 * Symmetric to the backend's `ws_ops_registry.register_ws_op` decorator
 * (services/chat-gateway/src/dcc_chat_gateway/routes/ws_ops_registry.py).
 * Plugins register one handler per op-code; the connection's dispatcher
 * looks it up by `evt.op`. Unknown ops log + are dropped (forward-compat:
 * a newer server can ship an op an older client doesn't yet handle).
 *
 * Why a runtime Map and not a static `switch`: this is the seam the
 * Phase-4 plugin loader hooks into. Plugins call `registerWsHandler` at
 * import time, identical to how a Svelte component subscribes to a store —
 * the dispatcher stays oblivious to who registered what.
 */
import type { ServerEvent } from './handlers/types';

export type WsHandler<E extends ServerEvent = ServerEvent> = (evt: E) => void | Promise<void>;

const handlers = new Map<string, WsHandler>();

/** Register a handler for `op`. Last registration wins — re-registering
 * the same op with the registry replaces the prior handler (matches the
 * backend's behaviour and lets the dev-only HMR path overwrite cleanly). */
export function registerWsHandler<Op extends ServerEvent['op']>(
  op: Op,
  fn: WsHandler<Extract<ServerEvent, { op: Op }>>
): void {
  handlers.set(op, fn as WsHandler);
}

/** Look up + invoke the handler for `evt.op`. Returns whatever the handler
 * returns (most are sync void; a few await dynamic imports). Unknown ops
 * are logged once and dropped. */
export function dispatch(evt: ServerEvent): void | Promise<void> {
  const h = handlers.get(evt.op);
  if (!h) {
    console.warn('[ws] unknown op:', evt.op);
    return;
  }
  return h(evt);
}

/** Unregister a handler — used by the plugin loader on unload. */
export function unregisterWsHandler(op: string): boolean {
  return handlers.delete(op);
}

/** Debug helper: list every op that currently has a handler. */
export function listWsHandlers(): string[] {
  return Array.from(handlers.keys());
}

/** Test/dev helper — wipes the registry. NOT exported via the barrel; the
 *  production code path never resets at runtime. */
export function _resetWsHandlers(): void {
  handlers.clear();
}
