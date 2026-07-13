/**
 * Teilbaren Einladungslink aus einem Invite-Code bauen — geteilt zwischen
 * GuildInvitesEditor (Community-Einstellungen) und InviteLinkShare
 * (Leute-einladen-Dialog), damit das Link-Format nie divergiert.
 *
 * Self-Host: der Link zeigt auf die WEB-App-Origin und trägt den Zielserver
 * als ``?host=`` — so landet der Empfänger im Universal-Beitrittsfeld-Flow
 * (Cert-Login + Grant), nicht auf dem Self-Host direkt.
 */

import { activeServer } from '$lib/stores/active-server.svelte';

export function inviteLink(code: string): string {
  const origin = window.location.origin;
  const srv = activeServer.current;
  if (!srv || srv.isCloud) return `${origin}/invite/${code}`;
  const host = srv.hostname.replace(/^https?:\/\//, '');
  return `${origin}/invite/${code}?host=${encodeURIComponent(host)}`;
}
