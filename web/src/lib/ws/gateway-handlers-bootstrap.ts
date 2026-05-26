/**
 * Einmaliger Bootstrap für die globale Handler-Registry (Singleton).
 * Multi-Connection: nur die erste Connection-Instanz hookt die Handler;
 * spätere Connections teilen sich dieselbe Registry. Multi-Server-Stores
 * sind Phase 4.5+ Scope.
 */

import { registerAllHandlers } from './handlers';
import { fireVoiceDiff } from './voiceDiff';

export type HandlerBootstrapDeps = {
  subs: Set<string>;
  unsubscribe: (channelId: string) => void;
  fireChannelDeleted: (guildId: string, channelId: string) => void;
  fireGuildDeleted: (guildId: string) => void;
  onReadySeeded: () => void;
};

let _bootstrapped = false;

export function bootstrapHandlersOnce(deps: HandlerBootstrapDeps): void {
  if (_bootstrapped) return;
  _bootstrapped = true;
  registerAllHandlers(
    {
      subs: deps.subs,
      unsubscribe: deps.unsubscribe,
      fireChannelDeleted: deps.fireChannelDeleted,
      fireGuildDeleted: deps.fireGuildDeleted,
      fireVoiceDiff,
    },
    { onReadySeeded: deps.onReadySeeded },
  );
}
