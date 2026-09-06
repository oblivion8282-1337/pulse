/**
 * Outbound-Op-Builder für GatewayConnection. Liegt extern damit
 * gateway-connection.ts ≤350 Z. bleibt. Alle Funktionen sind reine Frame-
 * Builder → der gegebene `sendRaw` queuet sie.
 */

import type { DeviceMonitor } from '$lib/api/devices';
import type { ClientEvent, RemoteSignalKind } from './handlers/types';

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
  action: 'play' | 'pause' | 'seek', position: number, sourceEpoch?: number,
): boolean {
  return send({
    op: 'watch_control', channel_id: channelId, party_id: partyId, action, position,
    source_epoch: sourceEpoch,
  });
}
export function changeWatchSource(
  send: SendRaw, channelId: string, partyId: string, sourceUrl: string,
): boolean {
  return send({
    op: 'watch_source_change', channel_id: channelId, party_id: partyId, source_url: sourceUrl
  });
}
export function sendWatchHeartbeat(
  send: SendRaw, channelId: string, partyId: string, position: number, sourceEpoch?: number,
): boolean {
  return send({
    op: 'watch_heartbeat', channel_id: channelId, party_id: partyId, position,
    source_epoch: sourceEpoch,
  });
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

// ── Fernsteuerung (remote control) — Consent-Handshake ──────────────────────
export function sendRemoteRequest(
  send: SendRaw,
  channelId: string,
  hostUserId: string,
  deviceId?: string | null,
  p2p = false,
): boolean {
  // `device_id` sagt, welches GERAET gemeint ist. Ohne das ginge die Einladung
  // an alle Fenster des Hosts, auch an seinen Laptop mit demselben Konto — und
  // dort zugestimmt, saehe der Steuernde den einen Rechner und bediente den
  // anderen (`$lib/remote/geraeteanbindung.ts`).
  return send({
    op: 'remote_request',
    channel_id: channelId,
    host_user_id: hostUserId,
    ...(deviceId ? { device_id: deviceId } : {}),
    // P2P-Wunsch: das Bild soll DIREKT zum Steuernden fließen, nicht über
    // MediaMTX. Der Gateway gibt die Markierung nur an den Host weiter —
    // verhandelt wird die Verbindung erst nach der Zusage (`remote_signal`).
    ...(p2p ? { p2p: true } : {}),
  });
}
/**
 * `slot` reist nur im P2P-Weg (`$lib/remote/direktbild.svelte.ts`): dort kennt
 * allein der Host den Platz seines wartenden Sidecars — eine Stromliste, aus
 * der der Steuernde ihn sonst lesen würde, gibt es ohne Server-Stream nicht.
 * Der Gateway prüft den Bereich und reicht die Zahl in der Zusage weiter.
 */
export function sendRemoteRespond(
  send: SendRaw,
  sessionId: string,
  accept: boolean,
  slot?: number,
): boolean {
  return send({
    op: 'remote_respond',
    session_id: sessionId,
    accept,
    ...(typeof slot === 'number' ? { slot } : {}),
  });
}
export function sendRemoteEnd(send: SendRaw, sessionId: string): boolean {
  return send({ op: 'remote_end', session_id: sessionId });
}
/**
 * Nach einem Verbindungsabriss zurück, innerhalb der Gnadenfrist: „gib der
 * Sitzung meinen neuen Socket" (`$lib/remote/wachten.ts`,
 * `ws_remote_reconnect.py::handle_reclaim`). Antwort ist `remote_reclaimed`
 * oder `remote_reclaim_failed`, nie stumm.
 */
export function sendRemoteReclaim(send: SendRaw, sessionId: string): boolean {
  return send({ op: 'remote_reclaim', session_id: sessionId });
}
/**
 * Eingabe-Frames zum Host (Wire-Protokoll v2, „Die Hülle auf dem Serverweg").
 * `frames` sind Base64 und **in Reihenfolge** — ein Klick, der seine
 * Positionierung überholt, landet am falschen Ort. Gebündelt hat der
 * Electron-Hauptprozess bereits (höchstens 32 je Nachricht).
 */
export function sendRemoteInput(
  send: SendRaw, sessionId: string, slot: number, frames: string[],
): boolean {
  return send({ op: 'remote_input', session_id: sessionId, slot, frames });
}
/**
 * SDP/ICE für den P2P-Eingabeweg (`$lib/remote/p2p.ts`) — der Gateway reicht
 * es peer-gebunden an das Gegenüber der aktiven Sitzung weiter
 * (`ws_remote_handlers.py::handle_signal`, 8 KiB, 60/s).
 */
export function sendRemoteSignal(
  send: SendRaw, sessionId: string, kind: RemoteSignalKind, data: unknown,
): boolean {
  return send({ op: 'remote_signal', session_id: sessionId, kind, data });
}

/** „Dieser Rechner ist das Standplatz-Geraet X."
 *
 *  Der Server kann das nicht erraten — er sieht Verbindungen von Nutzern, nicht
 *  von Rechnern (Begruendung in `$lib/devices/anmeldung.svelte.ts`). Geht nach
 *  JEDEM `ready` hinaus, auch nach einem Reconnect: die Anmeldung haengt am
 *  Socket und ist mit ihm weg. */
export function sendDeviceAnnounce(
  send: SendRaw,
  deviceId: string,
  // `DeviceMonitor` statt eines eigenen Inline-Typs — s. Kommentar dort
  // (`$lib/api/devices.ts`): dieselbe Form geht raus wie später zurückkommt.
  monitors: DeviceMonitor[] = [],
): boolean {
  // Die Bildschirme reisen mit der Anmeldung, weil nur der Rechner sie kennt —
  // und weil der Steuernde sie braucht, um „Monitor 2 dazuschalten" ueberhaupt
  // anbieten zu koennen (`$lib/devices/wecken.ts`).
  return send({ op: 'device_announce', device_id: deviceId, monitors });
}

/** Auf welchen Plaetzen dieser Rechner als GERAET sendet.
 *
 *  Der Server kann es nicht ableiten: der Strom laeuft unter dem Konto des
 *  Besitzers und traegt keine Geraete-Kennung. Ohne diese Meldung muesste die
 *  Oberflaeche raten, ob ein Strom vom Rechner oder vom Menschen davor kommt —
 *  und sie hat falsch geraten (LIVE-Abzeichen am unbeteiligten Standplatz,
 *  behoben 2026-08-16). Leere Liste heisst „sendet nicht". */
export function sendDeviceStreams(send: SendRaw, deviceId: string, slots: number[]): boolean {
  return send({ op: 'device_streams', device_id: deviceId, slots });
}

/** Die Anmeldung ausdruecklich zuruecknehmen (Eintragung entfernt), ohne die
 *  Verbindung zu kappen. */
export function sendDeviceWithdraw(send: SendRaw, deviceId: string): boolean {
  return send({ op: 'device_withdraw', device_id: deviceId });
}

/** „Fang bitte an zu uebertragen." Getrennt von der Fernsteuer-Anfrage, damit
 *  eine Sitzungszusage nicht an einer Encoder-Initialisierung haengt
 *  (`$lib/devices/wecken.ts`). */
export function sendDeviceWake(
  send: SendRaw,
  deviceId: string,
  monitor?: number,
  p2p = false,
): boolean {
  // Ohne Nummer nimmt das Geraet seinen Hauptbildschirm — so beginnt jede
  // Sitzung, die weiteren Schirme schaltet der Steuernde danach dazu.
  return send({
    op: 'device_wake',
    device_id: deviceId,
    ...(monitor === undefined ? {} : { monitor }),
    // P2P-Wunsch: das Gerät startet seinen Sidecar im Wartezustand — kein
    // WHIP-Push zum Server, das Bild geht später direkt zum Steuernden
    // (`$lib/devices/wecken.ts`, `$lib/remote/direktbild.svelte.ts`).
    ...(p2p ? { p2p: true } : {}),
  });
}
