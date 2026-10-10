/**
 * Teilbaren Einladungslink aus einem Invite-Code bauen — geteilt zwischen
 * GuildInvitesEditor (Community-Einstellungen) und InviteLinkShare
 * (Leute-einladen-Dialog), damit das Link-Format nie divergiert.
 *
 * Self-Host: der Link zeigt auf die WEB-App-Origin und trägt den Zielserver
 * als ``?host=`` — so landet der Empfänger im Universal-Beitrittsfeld-Flow
 * (Cert-Login + Grant), nicht auf dem Self-Host direkt. Die Rechnung selbst
 * steht importfrei in linkBau.ts.
 */

import { activeServer } from '$lib/stores/active-server.svelte';
import { adresseBauen, einladungsLinkBauen } from './linkBau';

export function inviteLink(code: string): string {
  return einladungsLinkBauen(window.location.origin, code, activeServer.current);
}

/** Teilbare öffentliche Community-Adresse (`/c/<handle>`), gleiche Regel wie `inviteLink`. */
export function oeffentlicheAdresse(handle: string): string {
  return adresseBauen(window.location.origin, handle, activeServer.current);
}
