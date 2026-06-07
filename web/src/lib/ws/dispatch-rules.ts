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
import { directMessages } from '$lib/stores/directMessages.svelte';

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
  'community_invite_received',
  'community_invite_removed',
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
