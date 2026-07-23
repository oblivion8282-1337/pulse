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
export function stopWatchParty(send: SendRaw, channelId: string, partyId: string): boolean {
  return send({ op: 'watch_stop', channel_id: channelId, party_id: partyId });
}
export function sendWatchControl(
  send: SendRaw, channelId: string, partyId: string,
  action: 'play' | 'pause' | 'seek', position: number,
): boolean {
  return send({ op: 'watch_control', channel_id: channelId, party_id: partyId, action, position });
}
export function changeWatchSource(
  send: SendRaw, channelId: string, partyId: string, sourceUrl: string,
): boolean {
  return send({
    op: 'watch_source_change', channel_id: channelId, party_id: partyId, source_url: sourceUrl
  });
}
export function sendWatchHeartbeat(
  send: SendRaw, channelId: string, partyId: string, position: number,
): boolean {
  return send({ op: 'watch_heartbeat', channel_id: channelId, party_id: partyId, position });
}
export function sendWatchJoin(send: SendRaw, channelId: string, partyId: string): boolean {
  return send({ op: 'watch_join', channel_id: channelId, party_id: partyId });
}
export function sendWatchLeave(send: SendRaw, channelId: string, partyId: string): boolean {
  return send({ op: 'watch_leave', channel_id: channelId, party_id: partyId });
}
export function sendWatchHandoff(
  send: SendRaw, channelId: string, partyId: string, targetUserId?: string,
): boolean {
  return send({
    op: 'watch_handoff', channel_id: channelId, party_id: partyId, target_user_id: targetUserId
  });
}

// ── Queue ────────────────────────────────────────────────────────────────
// Anyone in the channel may enqueue; remove/move/advance are gated server-side.
export function watchQueueAdd(
  send: SendRaw, channelId: string, partyId: string, sourceUrl: string,
): boolean {
  return send({
    op: 'watch_queue_add', channel_id: channelId, party_id: partyId, source_url: sourceUrl
  });
}
export function watchQueueRemove(
  send: SendRaw, channelId: string, partyId: string, itemId: string,
): boolean {
  return send({
    op: 'watch_queue_remove', channel_id: channelId, party_id: partyId, item_id: itemId
  });
}
export function watchQueueMove(
  send: SendRaw, channelId: string, partyId: string, itemId: string, index: number,
): boolean {
  return send({
    op: 'watch_queue_move', channel_id: channelId, party_id: partyId, item_id: itemId, index
  });
}
/** Promote a queued video to now-playing. No `itemId` = the first item
 *  (auto-advance when the current video ends); an id = play it now. Host only. */
export function watchQueueAdvance(
  send: SendRaw, channelId: string, partyId: string, itemId?: string,
): boolean {
  return send({
    op: 'watch_queue_advance', channel_id: channelId, party_id: partyId, item_id: itemId
  });
}

export function sendPluginOp(send: SendRaw, op: string, payload?: Record<string, unknown>): boolean {
  if (!op.includes(':')) {
    console.warn('[ws] sendPluginOp: op must be namespaced (e.g. "plugin:action"), got', op);
    return false;
  }
  return send({ op, ...(payload ?? {}) } as unknown as ClientEvent);
}
