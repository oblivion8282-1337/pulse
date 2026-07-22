/**
 * Barrel + bootstrapper for the WS handler map.
 *
 * `registerAllHandlers(ctx, readyCtx)` is called once by the gateway on
 * construction; each domain module installs its handlers into the
 * shared registry. Plugins extend the registry directly via
 * `registerWsHandler` from `../handler-registry` — they don't go
 * through here.
 */
import type { HandlerContext } from './context';
import * as chat from './chat';
import * as channels from './channels';
import * as guild from './guild';
import * as members from './members';
import * as voice from './voice';
import * as presence from './presence';
import * as stream from './stream';
import * as watch from './watch';
import * as remote from './remote';
import * as friends from './friends';
import * as ready from './ready';
import * as error from './error';
import * as admin from './admin';

export type { HandlerContext } from './context';
export type { ReadyContext } from './ready';

export function registerAllHandlers(
  ctx: HandlerContext,
  readyCtx: ready.ReadyContext
): void {
  ready.register(readyCtx);
  chat.register(ctx);
  channels.register(ctx);
  guild.register(ctx);
  members.register(ctx);
  voice.register(ctx);
  presence.register();
  stream.register();
  watch.register();
  remote.register();
  friends.register();
  error.register();
  admin.register();
}
