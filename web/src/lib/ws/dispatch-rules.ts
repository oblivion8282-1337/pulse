/**
 * Global-Friends Stufe 1 — Dispatch-Regeln für die Cloud-Background-Connection.
 *
 * Hintergrund: Bis Stufe 1 dispatchte **nur die aktive** Connection
 * (`gateway-connection._handle`: `if (this.serverId !== activeServer.serverId)
 * return;`). Freunde/DMs/Friend-Requests/Blocks/Freund-Presence sind aber jetzt
 * eine **globale Cloud-Schicht** und müssen auch dann live ankommen, wenn der
 * aktive Server ein Self-Host ist. Dafür darf die **Cloud**-Connection eine
 * definierte Op-Allowlist auch im Hintergrund (nicht-aktiv) dispatchen.
 *
 * `backgroundEligible(evt)` ist genau diese Allowlist. Sie wird in `_handle`
 * UND im `ready`-Split (Social-Teil) genutzt. Guild-/Voice-/Stream-/Watch-Ops
 * sind bewusst NICHT dabei — die bleiben aktiv-only.
 */

import type { ServerEvent } from './handlers/types';
import type { GatewayConnection } from './gateway-connection';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { geraeteAnmeldung } from '$lib/devices/anmeldung.svelte';

/**
 * PURE_SOCIAL — Friend-/Block-/DM-Lifecycle, immer global. Diese Ops haben
 * keinen Channel-Bezug zu einem konkreten Guild; sie betreffen ausschließlich
 * die globale Cloud-Social-Schicht und sind im Hintergrund immer erlaubt.
 */
const PURE_SOCIAL_OPS: ReadonlySet<ServerEvent['op']> = new Set([
  'friend_request_received',
  'friend_request_accepted',
  'friend_request_declined',
  'friend_request_cancelled',
  'friend_removed',
  'user_blocked',
  'user_unblocked',
  'dm_bump',
]);

/**
 * PRESENCE — Freund-Presence (online/offline + Status). Cloud-Freund-IDs und
 * Self-Host-pairwise-IDs sind disjunkt, daher koexistieren Cloud-Freund-Presence
 * (Background) und Guild-Presence (aktiv) konfliktfrei im selben Store.
 */
const PRESENCE_OPS: ReadonlySet<ServerEvent['op']> = new Set([
  'presence_update',
  'presence_status_changed',
]);

/**
 * MESSAGE-Familie — nur im Hintergrund erlaubt, **wenn der Ziel-Channel ein
 * DM-Channel ist** (Lookup im `directMessages`-Store). Eine Guild-Message vom
 * Cloud-Server, während ein Self-Host aktiv ist, darf NICHT durch — sonst
 * würde sie die Stores des aktiven Self-Host-Servers verfälschen.
 */
const MESSAGE_FAMILY_OPS: ReadonlySet<ServerEvent['op']> = new Set([
  'message',
  'message_update',
  'message_delete',
  'reaction_add',
  'reaction_remove',
  'typing',
  'message_ack',
  'mention_added',
]);

/** Liest die `channel_id` aus den unterschiedlichen MESSAGE-Familie-Shapes.
 *  Manche Ops tragen `channel_id` flach (`message_delete`, `typing`,
 *  `reaction_*`), andere im `data`-Wrapper (`message`, `mention_added`). */
function channelIdOf(evt: ServerEvent): string | null {
  const flat = (evt as { channel_id?: string }).channel_id;
  if (typeof flat === 'string') return flat;
  const data = (evt as { data?: { channel_id?: string } }).data;
  if (data && typeof data.channel_id === 'string') return data.channel_id;
  return null;
}

/** True, wenn `channelId` ein bekannter 1:1-DM-Channel ist (Cloud-only). */
function isDmChannel(channelId: string | null): boolean {
  return !!channelId && channelId in directMessages.byId;
}

/**
 * Entscheidet, ob die **Cloud**-Connection ein Event auch im Hintergrund
 * (während ein anderer Server aktiv ist) dispatchen darf.
 *
 * - PURE_SOCIAL + PRESENCE → immer true.
 * - MESSAGE-Familie → nur wenn `evt.channel_id` ein DM-Channel ist.
 * - alles andere (Guild/Voice/Stream/Watch/Roles/…) → false (aktiv-only).
 *
 * Wird ausschließlich auf der Cloud-Connection ausgewertet; die aktive
 * Connection dispatcht weiterhin alles.
 */
export function backgroundEligible(evt: ServerEvent): boolean {
  if (PURE_SOCIAL_OPS.has(evt.op)) return true;
  if (PRESENCE_OPS.has(evt.op)) return true;
  if (MESSAGE_FAMILY_OPS.has(evt.op)) return isDmChannel(channelIdOf(evt));
  return false;
}

/**
 * Die Frames einer LAUFENDEN Fernsteuerungs-Sitzung — der zweite Grund, warum
 * eine nicht-aktive Verbindung dispatchen darf.
 *
 * Eine Fernsteuerung hängt an genau der Verbindung, auf der sie zustande kam
 * (`remote/session.svelte.ts::#conn`). Wechselt eine der beiden Seiten während
 * der Sitzung die Community, ist diese Verbindung nicht mehr die aktive — und
 * ohne diese Ausnahme fiel ihr `remote_ended` in die Regel oben und wurde
 * verworfen: beim Steuernden blieb die Erfassung von Maus und Tastatur an, beim
 * Host das Warnbanner stehen, und die Sitzung war nur noch von Hand zu beenden.
 *
 * `remote_request` steht bewusst NICHT in der Liste: eine NEUE Einladung zur
 * Hergabe des eigenen Rechners soll nur dort auftauchen, wo man gerade ist —
 * ein Zustimmungsdialog aus einer Community, die man nicht ansieht, wäre genau
 * der Klick, der aus Versehen passiert.
 */
const REMOTE_SESSION_OPS: ReadonlySet<ServerEvent['op']> = new Set([
  'remote_pending',
  'remote_response',
  'remote_ended',
  'remote_canceled',
  'remote_input',
  'remote_signal',
]);

/** Die Verbindung der laufenden Sitzung. Der Session-Store meldet sie an und
 *  beim Ende wieder ab — außerhalb einer Sitzung ist die Ausnahme also gar
 *  nicht scharf. */
let sitzungsVerbindung: GatewayConnection | null = null;

export function setRemoteSessionConnection(conn: GatewayConnection | null): void {
  sitzungsVerbindung = conn;
}

/** True, wenn `conn` die Verbindung der laufenden Fernsteuerung ist UND `evt`
 *  zu deren Frames gehört. Identitätsvergleich, nicht `serverId`: die Sitzung
 *  hängt am Objekt, das sie trägt. */
export function remoteSessionEligible(conn: GatewayConnection, evt: ServerEvent): boolean {
  if (sitzungsVerbindung === null || conn !== sitzungsVerbindung) return false;
  return REMOTE_SESSION_OPS.has(evt.op);
}

/**
 * Ist dieser Rechner auf `serverId` als Standplatz-Gerät eingetragen?
 *
 * Der dritte Grund, warum eine nicht-aktive Verbindung dispatchen darf — und
 * der einzige, der auch für einen Self-Host gilt: ein Standplatz-Gerät ist
 * **immer** unbeaufsichtigt, also so gut wie nie auf dem Server, den sein
 * Fenster gerade anzeigt.
 */
export function istGeraetAuf(serverId: string): boolean {
  return geraeteAnmeldung.fuerServer(serverId) !== null;
}

/**
 * Die Ops, die ein eingetragenes Gerät auch im Hintergrund erreichen müssen.
 *
 * **Der Fehlerfall** (Bughunt 2026-08-16): ein Gerät auf einem nicht-aktiven
 * Server war tot. `device_wake` fiel in die Regel oben und wurde verworfen, das
 * Gerät fing also nie an zu übertragen; und weil auch sein `ready` verworfen
 * wurde (s. `gateway-connection._handle`), meldete es sich dort gar nicht erst
 * an — es stand für alle anderen dauerhaft auf „offline". Dass ein Standplatz-
 * Rechner nebenher irgendeine Community offen hat, ist dabei der Normalfall und
 * kein Sonderfall: niemand sitzt davor, um auf den richtigen Server zu wechseln.
 *
 * **`remote_request` nur, wenn die Anfrage GENAU dieses Gerät nennt.** Der Grund
 * gegen eine Einladung aus einer Community, die man nicht ansieht, bleibt sonst
 * unberührt (s. `REMOTE_SESSION_OPS`): eine Anfrage ohne Gerätekennung meint
 * einen Menschen, und die soll weiterhin nur dort auftauchen, wo er gerade ist.
 * Eine Anfrage MIT unserer Kennung meint dagegen den Rechner selbst — dort ist
 * die Zustimmung als Dauerfreigabe längst erteilt, und ohne diesen Weg käme sie
 * nie an.
 */
export function geraeteEligible(conn: GatewayConnection, evt: ServerEvent): boolean {
  if (evt.op !== 'device_wake' && evt.op !== 'remote_request') return false;
  const eintrag = geraeteAnmeldung.fuerServer(conn.serverId);
  if (!eintrag) return false;
  return evt.op === 'device_wake' || evt.device_id === eintrag.deviceId;
}
