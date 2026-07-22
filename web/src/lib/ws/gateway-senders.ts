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

export function sendPluginOp(send: SendRaw, op: string, payload?: Record<string, unknown>): boolean {
  if (!op.includes(':')) {
    console.warn('[ws] sendPluginOp: op must be namespaced (e.g. "plugin:action"), got', op);
    return false;
  }
  return send({ op, ...(payload ?? {}) } as unknown as ClientEvent);
}

// ── Fernsteuerung (remote control, M3) ──────────────────────────────────────
export type RemoteSignalKind = 'offer' | 'answer' | 'ice';

export function sendRemoteRequest(send: SendRaw, channelId: string, hostUserId: string): boolean {
  return send({ op: 'remote_request', channel_id: channelId, host_user_id: hostUserId });
}
export function sendRemoteRespond(send: SendRaw, sessionId: string, accept: boolean): boolean {
  return send({ op: 'remote_respond', session_id: sessionId, accept });
}
export function sendRemoteSignal(
  send: SendRaw, sessionId: string, kind: RemoteSignalKind, data: string,
): boolean {
  return send({ op: 'remote_signal', session_id: sessionId, kind, data });
}
export function sendRemoteEnd(send: SendRaw, sessionId: string): boolean {
  return send({ op: 'remote_end', session_id: sessionId });
}
