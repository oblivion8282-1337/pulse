/**
 * Server-Hinzufügen-Orchestrator — Phase 5.2.
 *
 * Bündelt die Schritte die nach dem Pre-Check passieren müssen:
 *   1. ServerEntry provisional anlegen (für Token-Mapping)
 *   2. Server-Info → Ticket von der Cloud → Sitzung des Servers
 *   3. (optional) Invite-Code akzeptieren gegen den neuen Server
 *   4. Disclaimer-Flags + activeServer.set werden vom Caller gemacht
 *
 * Bei Anmelde-Fehler: ServerEntry wird wieder entfernt (Rollback).
 * Bei Invite-Fail: ServerEntry bleibt, der Fehler wird durchgereicht — der
 *   User hat den Server hinzugefügt, der Invite hat nur nicht geklappt.
 *
 * NIEMALS session_token loggen.
 */

import { m } from '$lib/paraglide/messages.js';
import { request, type RequestOpts } from './client';
import { instancesApi } from './instances';
import { persistDisclaimerAck } from './disclaimer-ack';
import { serversStore, type ServerEntry } from './servers.svelte';
import { sessionTokens } from './session_tokens.svelte';
import { holeTicket, loeseTicketEin } from './server-ticket';
import { MELDUNGSSCHLUESSEL, istAblehnungscode } from './anmelde-fehler-codes';
import type { AcceptInviteResult, InvitePreview } from './types';

type AddServerSuccess = {
  entry: ServerEntry;
  invite: AcceptInviteResult | null;
  inviteError: string | null;
};

/**
 * Sentinel-Fehler: wird geworfen, BEVOR ein **neuer, unbekannter** Self-Host
 * kontaktiert wird (Cert-Challenge gegen `target_host` würde sonst
 * IP und Zeitpunkt an einen evtl. präparierten Host leaken).
 *
 * Der Caller fängt ihn, zeigt dem User einen Bestätigungs-Dialog mit dem
 * Hostnamen und ruft die ursprüngliche Funktion erneut auf — diesmal mit
 * `confirmed: true`. Cloud-Ziele und bereits bekannte Server lösen ihn NIE aus.
 */
export class SelfHostContactConfirmRequired extends Error {
  constructor(public readonly hostname: string) {
    super('self-host-contact-confirm-required');
    this.name = 'SelfHostContactConfirmRequired';
  }
}

/** True, wenn der User den Erstkontakt mit diesem Self-Host schon bestätigt hat
 *  (localStorage-Flag aus markSelfHostDisclaimerSeen / dem Bestätigungs-Dialog). */
export function selfHostContactConfirmed(hostname: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(`pulse.disclaimer_accepted_${hostname}`) === '1';
  } catch {
    return false;
  }
}

/** Merkt sich, dass der User den Erstkontakt mit diesem Self-Host bestätigt hat. */
export function markSelfHostContactConfirmed(hostname: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`pulse.disclaimer_accepted_${hostname}`, '1');
  } catch { /* Quota/Private-Browsing: silent */ }
}

/**
 * Hängt den Server an, holt den Session-Token, optional Invite akzeptieren.
 *
 * @throws CertLoginError wenn der Cert-Login fehlschlägt (kein ServerEntry persistiert).
 * @throws Error für andere unerwartete Fehler vor dem Cert-Login (kein ServerEntry persistiert).
 */
export async function addServerWithCertLogin(args: {
  hostname: string;
  label?: string;
  instanceId?: string;
  inviteCode?: string;
  /**
   * Community-Invite-Code (Stufe 3). Wird als `community_grant_code` an
   * cert-login/verify weitergegeben → gewährt community-scoped Mitgliedschaft
   * auf dem Self-Host-Server beim ersten Login.
   */
  communityGrantCode?: string;
  /**
   * Öffentlicher Community-Handle (Stufe 4). Wird als `public_join_handle` an
   * cert-login/verify weitergegeben → gewährt community-scoped Mitgliedschaft
   * auf dem Self-Host-Server beim ersten Login via öffentlicher Adresse.
   */
  publicJoinHandle?: string;
}): Promise<AddServerSuccess> {
  const entry = serversStore.add(args.hostname, args.label, args.instanceId);

  // Erstkontakt über das Ticket. Der Klient nennt der Cloud den HOSTNAMEN und
  // lässt sie die Instanz auflösen — er fragt den fremden Server NICHT nach
  // seiner Kennung. Täte er das, könnte ein bösartiger Host die Kennung eines
  // anderen Servers melden, ein darauf ausgestelltes Ticket entgegennehmen und
  // es dort einlösen.
  let sitzung;
  let instanzId: string;
  try {
    const { ticket, instanceId } = await holeTicket(args.hostname);
    instanzId = instanceId;
    sitzung = await loeseTicketEin(args.hostname, ticket, {
      communityGrantCode: args.communityGrantCode,
      publicJoinHandle: args.publicJoinHandle,
    });
  } catch (err) {
    // Rollback — ServerEntry war provisional.
    try { serversStore.remove(entry.id); } catch { /* Cloud nie hier */ }
    sessionTokens.clear(entry.id);
    throw err;
  }

  sessionTokens.set(entry.id, sitzung.session_token, Date.now() + sitzung.expires_in * 1000);
  serversStore.update(entry.id, {
    je_verbunden: true,
    // Ohne die Kennung kann der Sweep gelöschter Instanzen
    // (deleted-instance-sweep.ts) den Eintrag nicht zuordnen.
    ...(entry.instance_id == null ? { instance_id: instanzId } : {}),
  });

  // Cloud-Membership eintragen, damit dieser Self-Host-Server auch im Browser /
  // auf anderen Geräten in der Server-Liste (``GET /me/instances``) auftaucht.
  // Best-effort: ein Fehler darf das Hinzufügen NICHT abbrechen (der Server
  // läuft lokal weiter, der nächste Reauth-Backfill holt es nach).
  const instanceId = instanzId ?? args.instanceId ?? entry.instance_id;
  if (instanceId) {
    void instancesApi.joinInstanceMembership(instanceId).catch(() => undefined);
  }

  // Optional: Invite-Code akzeptieren — gegen den NEUEN Server (per serverId-Route).
  let invite: AcceptInviteResult | null = null;
  let inviteError: string | null = null;
  if (args.inviteCode) {
    try {
      invite = await acceptInvite(args.inviteCode, { serverId: entry.id });
    } catch (e) {
      // Server bleibt — der User hat einen funktionierenden Account dort.
      inviteError = (e as Error).message ?? m.add_server_flow_invite_failed();
    }
  }
  return { entry, invite, inviteError };
}

// ---------------------------------------------------------------------------
// Invite-API mit serverId-Route — wir können chatApi.* nicht nutzen, weil das
// auf den active-server geht. Diese Helfer routen explizit an einen Server.
// ---------------------------------------------------------------------------

const reqOpts = (method: RequestOpts['method']): RequestOpts => ({ method });

export function getInvitePreviewOn(
  code: string,
  route: { serverId: string },
): Promise<InvitePreview> {
  return request<InvitePreview>(`/invites/${code}`, reqOpts('GET'), route);
}

export function acceptInvite(
  code: string,
  route: { serverId: string },
): Promise<AcceptInviteResult> {
  return request<AcceptInviteResult>(`/invites/${code}/accept`, reqOpts('POST'), route);
}

/**
 * Echtes Austreten aus einer Self-Host-Instanz (DELETE /me/instance-membership).
 * 403 = Instanz-Owner (kann nicht austreten) · 409 = besitzt noch Communitys.
 */
export function leaveInstanceOn(route: { serverId: string }): Promise<void> {
  return request<void>(`/me/instance-membership`, reqOpts('DELETE'), route);
}

// ---------------------------------------------------------------------------
// UI-Helpers — hier statt im Svelte-Component, damit die Component unter dem
// 250-Z.-Cap bleibt.
// ---------------------------------------------------------------------------

/**
 * Fehlermeldung für einen `TicketFehler.code`.
 *
 * Die Texte stehen im gemeinsamen Katalog (`anmelde-fehler-codes.ts`), damit
 * derselbe Grund überall denselben Satz und denselben Handgriff bekommt — im
 * Hinzufügen-Dialog wie im laufenden Betrieb. Die Vorgängerfassung führte
 * eigene Sätze und lief deshalb langsam auseinander.
 *
 * `join_not_permitted` bleibt bewusst von `join_locked` getrennt: „gesperrt" ist
 * ein Admin-Zustand des Servers, „verlangt Einladung" ein lösbarer Zustand —
 * das Beitrittsfeld blendet dafür ein Code-Feld ein.
 */
export function anmeldeFehlerText(code: string): string {
  const katalog = m as unknown as Record<string, (() => string) | undefined>;
  const schluessel = istAblehnungscode(code) ? MELDUNGSSCHLUESSEL[code] : null;
  const fn = schluessel ? katalog[schluessel] : undefined;
  return typeof fn === 'function' ? fn() : m.add_server_flow_cert_login_failed();
}

/** Markiert den Disclaimer als bestätigt: hostname-Flag lokal (Erstkontakt-
 *  Dialog) + serverId-Bestätigung lokal UND auf dem Server (geräteüber-
 *  greifend, s. disclaimer-ack.ts) — der bewusste Confirm beim Hinzufügen
 *  IST die Bestätigung, der Banner soll danach auf keinem Gerät hochpoppen. */
export function markSelfHostDisclaimerSeen(hostname: string, serverId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`pulse.disclaimer_accepted_${hostname}`, '1');
  } catch { /* Quota/Private-Browsing: silent */ }
  persistDisclaimerAck(serverId);
}
