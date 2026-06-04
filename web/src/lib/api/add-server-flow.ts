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
import type { AcceptInviteResult, InvitePreview } from './types';

export type AddServerSuccess = {
  entry: ServerEntry;
  invite: AcceptInviteResult | null;
  inviteError: string | null;
};

/**
 * Hängt den Server an, holt den Session-Token, optional Invite akzeptieren.
 *
 * @throws CertLoginError wenn der Cert-Login fehlschlägt (kein ServerEntry persistiert).
 * @throws Error für andere unerwartete Fehler vor dem Cert-Login (kein ServerEntry persistiert).
 */
export async function addServerWithCertLogin(args: {
  hostname: string;
  label: string;
  instanceId?: string;
  inviteCode?: string;
}): Promise<AddServerSuccess> {
  const entry = serversStore.add(args.hostname, args.label, args.instanceId);

  let result;
  try {
    result = await certLogin(args.hostname);
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

/** Deutsche Fehlermeldung für einen CertLoginError.reason. */
export function mapCertLoginReason(reason: CertLoginReason): string {
  if (reason === 'no-cert' || reason === 'no-keypair')
    return m.add_server_flow_no_cert();
  if (reason === 'cert-invalid')
    return m.add_server_flow_cert_invalid();
  if (reason === 'challenge-expired') return m.add_server_flow_challenge_expired();
  if (reason === 'signature-invalid')
    return m.add_server_flow_signature_invalid();
  if (reason === 'rate-limited') return m.add_server_flow_rate_limited();
  if (reason === 'network') return m.add_server_flow_network_error();
  return m.add_server_flow_cert_login_failed();
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
