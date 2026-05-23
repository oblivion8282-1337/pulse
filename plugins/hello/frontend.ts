/**
 * Hello-Plugin frontend entry — Pulse Plugin-System Schritt-4 smoke test.
 *
 * Registers a single WS handler for `hello:pong`. The backend half
 * (`plugins/hello/backend.py`) registers the matching `hello:ping`
 * op; pinging it from the browser and seeing this handler fire proves
 * the loader works end-to-end. Logs only — no side effects on app state.
 */
import { registerWsHandler, unregisterWsHandler } from '../../web/src/lib/ws/handler-registry';

interface HelloPongPayload {
  op: 'hello:pong';
  echo?: unknown;
}

export default function register(): void {
  // The handler-registry types the op against `ServerEvent`; `hello:pong`
  // isn't part of the core event union, so we cast through `never` to
  // tell TypeScript the plugin author owns this op-code. (Schritt 5 will
  // formalise this — plugins will register their op into the event
  // registry so the type system knows about it natively.)
  registerWsHandler('hello:pong' as never, ((evt: HelloPongPayload) => {
    console.log('[hello-plugin] pong:', evt.echo);
  }) as never);
}

export function deactivate(): void {
  unregisterWsHandler('hello:pong');
}
