/**
 * Outbound-Op-Builder für GatewayConnection. Liegt extern damit
 * gateway-connection.ts ≤350 Z. bleibt. Alle Funktionen sind reine Frame-
 * Builder → der gegebene `sendRaw` queuet sie.
 */

import type { ClientEvent } from './handlers/types';

export type SendRaw = (evt: ClientEvent) => boolean;

export function sendVoiceSelfState(
  send: SendRaw, channelId: string | null, micMuted: boolean, deafened: boolean,
): boolean {
  return send({ op: 'voice_self_state', channel_id: channelId, mic_muted: micMuted, deafened });
}

export function startWatchParty(send: SendRaw, channelId: string, sourceUrl: string): boolean {
  return send({ op: 'watch_start', channel_id: channelId, source_url: sourceUrl });
}
export function stopWatchParty(send: SendRaw, channelId: string): boolean {
  return send({ op: 'watch_stop', channel_id: channelId });
}
export function sendWatchControl(
  send: SendRaw, channelId: string, action: 'play' | 'pause' | 'seek', position: number,
): boolean {
  return send({ op: 'watch_control', channel_id: channelId, action, position });
}
export function sendWatchHeartbeat(send: SendRaw, channelId: string, position: number): boolean {
  return send({ op: 'watch_heartbeat', channel_id: channelId, position });
}

export function sendPluginOp(send: SendRaw, op: string, payload?: Record<string, unknown>): boolean {
  if (!op.includes(':')) {
    console.warn('[ws] sendPluginOp: op must be namespaced (e.g. "plugin:action"), got', op);
    return false;
  }
  return send({ op, ...(payload ?? {}) } as unknown as ClientEvent);
}
