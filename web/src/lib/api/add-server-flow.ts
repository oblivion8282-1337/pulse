/**
 * Server-Hinzufügen-Orchestrator — Phase 5.2.
 *
 * Bündelt die Schritte die nach dem Pre-Check passieren müssen:
 *   1. ServerEntry provisional anlegen (für Token-Mapping)
 *   2. Cert-Login → Session-Token
 *   3. (optional) Invite-Code akzeptieren gegen den neuen Server
 *   4. Disclaimer-Flags + activeServer.set werden vom Caller gemacht
 *
 * Bei Cert-Login-Fail: ServerEntry wird wieder entfernt (Rollback).
 * Bei Invite-Fail: ServerEntry bleibt, der Fehler wird durchgereicht — der
 *   User hat den Server hinzugefügt, der Invite hat nur nicht geklappt.
 *
 * NIEMALS session_token loggen.
 */

import { m } from '$lib/paraglide/messages.js';
import { request, type RequestOpts } from './client';
import { serversStore, type ServerEntry } from './servers.svelte';
import { sessionTokens } from './session_tokens.svelte';
import { certLogin, CertLoginError, type CertLoginReason } from './cert-login';
import { communityInvitesApi, type CommunityInvitePayload } from './community-invites';
import type { AcceptInviteResult, InvitePreview } from './types';

export type AddServerSuccess = {
  entry: ServerEntry;
  invite: AcceptInviteResult | null;
  inviteError: string | null;
};

/**
 * Sentinel-Fehler: wird geworfen, BEVOR ein **neuer, unbekannter** Self-Host
 * kontaktiert wird (Cert-Challenge gegen `target_host` würde sonst
 * IP/Zeitpunkt/pairwise_sub an einen evtl. präparierten Host leaken).
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

/** Normalisiert einen bare/vollen Hostname auf HTTPS-Origin (lowercase, kein
 *  trailing slash) — gleiche Regel wie serversStore.normalizeHostname, hier
 *  dupliziert, weil die dortige Fassung privat ist. */
function normalizeSelfHostUrl(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\/$/, '');
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice('http://'.length)}`;
  if (!trimmed.startsWith('https://')) return `https://${trimmed}`;
  return trimmed;
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

  let result;
  try {
    result = await certLogin(args.hostname, args.communityGrantCode, args.publicJoinHandle);
  } catch (err) {
    // Rollback — ServerEntry war provisional.
    try { serversStore.remove(entry.id); } catch { /* Cloud nie hier */ }
    sessionTokens.clear(entry.id);
    throw err;
  }

  sessionTokens.set(entry.id, result.session_token, Date.now() + result.expires_in * 1000);
  serversStore.update(entry.id, { pairwise_sub: result.pairwise_sub });

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

// ---------------------------------------------------------------------------
// UI-Helpers — hier statt im Svelte-Component, damit die Component unter dem
// 250-Z.-Cap bleibt.
// ---------------------------------------------------------------------------

/** Fehlermeldung für einen CertLoginError.reason. */
export function mapCertLoginReason(reason: CertLoginReason): string {
  if (reason === 'no-cert' || reason === 'no-keypair')
    return m.add_server_flow_no_cert();
  if (reason === 'cert-invalid')
    return m.add_server_flow_cert_invalid();
  if (reason === 'challenge-expired') return m.add_server_flow_challenge_expired();
  if (reason === 'signature-invalid')
    return m.add_server_flow_signature_invalid();
  if (reason === 'rate-limited') return m.add_server_flow_rate_limited();
  if (reason === 'join-closed' || reason === 'join-requires-invite')
    return m.add_server_flow_join_closed();
  if (reason === 'network') return m.add_server_flow_network_error();
  return m.add_server_flow_cert_login_failed();
}

// ---------------------------------------------------------------------------
// Community-Invite-Accept-Flow (Stufe 3)
// ---------------------------------------------------------------------------

/**
 * Nimmt eine Community-Einladung an.
 *
 * - Cloud-Community (target_host == Cloud): einfaches `acceptInvite` cloud-geroutet.
 * - Self-Host-Community: `addServerWithCertLogin` mit `communityGrantCode` (gewährt
 *   Instanz-Mitgliedschaft via cert-login/verify) UND `inviteCode` (Guild-Beitritt
 *   via POST /invites/{code}/accept).
 *
 * **Sicherheits-Gate:** Bei einem **neuen, unbekannten** Self-Host wird VOR dem
 * ersten Kontakt `SelfHostContactConfirmRequired` geworfen, solange `confirmed`
 * nicht true ist und der User den Host noch nicht früher bestätigt hat (sonst
 * leakt die Cert-Challenge Metadaten an einen evtl. präparierten Host). Der
 * Caller zeigt einen Bestätigungs-Dialog und ruft mit `confirmed: true` erneut auf.
 * Cloud-Ziele und bereits bekannte Server lösen das Gate nie aus.
 *
 * Nach erfolgreichem Join wird der Invite via `communityInvitesApi.remove` B-lite gelöscht.
 * Wirft einen `Error` mit Klartext-Meldung — Caller zeigt Toast.
 */
export async function acceptCommunityInvite(
  inv: CommunityInvitePayload,
  confirmed = false,
): Promise<void> {
  const cloudEntry = serversStore.servers.find((s) => s.isCloud);
  const cloudId = cloudEntry?.id;
  if (!cloudId) throw new Error('Kein Cloud-Server konfiguriert.');

  // Cloud-Community wenn target_host der Cloud-Hostname entspricht
  const cloudHostname = cloudEntry.hostname;
  const isCloud = !inv.target_host || inv.target_host === cloudHostname;

  if (isCloud) {
    // Cloud-Community: invite-code direkt bei der Cloud einlösen.
    await acceptInvite(inv.code, { serverId: cloudId });
  } else {
    // Self-Host: Server hinzufügen (falls noch nicht da) + cert-login mit grant-code.
    const normalized = normalizeSelfHostUrl(inv.target_host);
    let entry = serversStore.findByHostname(normalized);
    if (!entry) {
      // Erstkontakt-Gate: neuer, unbekannter Self-Host → bestätigen lassen, BEVOR
      // wir die Cert-Challenge gegen target_host schicken.
      if (!confirmed && !selfHostContactConfirmed(normalized)) {
        throw new SelfHostContactConfirmRequired(normalized);
      }
      markSelfHostContactConfirmed(normalized);
      // Server noch unbekannt → hinzufügen + cert-login mit community_grant_code.
      // label = guild-name als Orientierung; kann der User später umbenennen.
      //
      // ABSICHT: communityGrantCode === inviteCode === inv.code. Ein gültiger
      // host-GuildInvite-Code dient laut Backend-Kontrakt ZUGLEICH als
      // `community_grant_code` (gewährt die community-scoped Instanz-Mitgliedschaft
      // im cert-login/verify) UND als `inviteCode` (Guild-Beitritt via
      // POST /invites/{code}/accept). Derselbe Code, zwei Verwendungen.
      const result = await addServerWithCertLogin({
        hostname: normalized,
        label: inv.target_guild_name,
        instanceId: inv.target_instance_id ?? undefined,
        inviteCode: inv.code,
        communityGrantCode: inv.code,
      });
      entry = result.entry;
    } else {
      // Server bereits bekannt → nur Invite akzeptieren.
      await acceptInvite(inv.code, { serverId: entry.id });
    }
  }

  // B-lite: Invite nach erfolgreichem Join entfernen (best-effort — kein Fail-Block).
  try {
    await communityInvitesApi.remove(inv.id);
  } catch {
    /* ignoriert — der Join hat geklappt, nur die Cleanup-Anfrage ist fehlgeschlagen */
  }
}

/** Setzt die zwei Disclaimer-Flags (hostname-keyed + serverId-keyed) im
 *  localStorage, damit der SelfHostDisclaimer-Banner nach dem Hinzufügen
 *  nicht erneut hochpoppt. Best-effort (Quota/Private-Browsing: silent). */
export function markSelfHostDisclaimerSeen(hostname: string, serverId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`pulse.disclaimer_accepted_${hostname}`, '1');
    window.localStorage.setItem(`pulse.disclaimer_seen_${serverId}`, '1');
  } catch { /* Quota/Private-Browsing: silent */ }
}
