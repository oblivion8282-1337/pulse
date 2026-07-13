/**
 * Host-Zweig des Universal-Beitrittsfelds (ersetzt den AddServerDialog).
 *
 * Ablauf, den der Join-Dialog (JoinGuildStep) treibt:
 *  1. ``prepareHostJoin``: Pre-Check via /.well-known/pulse-server-info +
 *     Duplikat-Check gegen die lokale Server-Liste.
 *  2. Erstkontakt-Gate (SelfHostContactConfirmRequired → Dialog im Caller).
 *  3. ``joinServerByHost`` OHNE Code: Cert-Login ohne Grant. Antwortet der
 *     Server mit ``join_not_permitted`` (CertLoginError 'join-requires-invite'),
 *     blendet der Dialog ein Code-Feld ein und ruft erneut MIT Code —
 *     derselbe Code dient als communityGrantCode UND inviteCode (wie im
 *     früheren AddServerDialog-confirmAdd).
 *
 * Kein Anzeigename-Feld mehr: den Namen bestimmt der Server-Admin
 * (server_name aus dem ready-Frame), Fallback ist der Hostname.
 */

import { goto } from '$app/navigation';
import { toast } from 'svelte-sonner';
import { m } from '$lib/paraglide/messages.js';
import { preCheckServer } from '$lib/api/server-info';
import { serversStore } from '$lib/api/servers.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import { guilds } from '$lib/stores/guilds.svelte';
import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
import { joinedInvites } from '$lib/stores/joinedInvites.svelte';
import {
  addServerWithCertLogin,
  markSelfHostDisclaimerSeen,
  selfHostContactConfirmed,
  markSelfHostContactConfirmed,
  SelfHostContactConfirmRequired,
} from '$lib/api/add-server-flow';

export type HostJoinPrepared =
  | { ok: true; hostname: string }
  | { ok: false; message: string };

function mapPreCheckError(reason: string): string {
  if (reason === 'too-old') return m.add_server_dialog_error_too_old();
  if (reason === 'unreachable') return m.add_server_dialog_error_unreachable();
  if (reason === 'cors') return m.add_server_dialog_error_cors();
  if (reason === 'bad-url') return m.add_server_dialog_error_bad_url();
  return m.add_server_dialog_error_unreadable();
}

/** Pre-Check + Duplikat-Check. Gibt den normalisierten ``https://…``-Hostname
 *  zurück oder eine anzeigbare Fehlermeldung. */
export async function prepareHostJoin(raw: string): Promise<HostJoinPrepared> {
  const result = await preCheckServer(raw);
  if (!result.ok) return { ok: false, message: mapPreCheckError(result.reason) };
  if (serversStore.findByHostname(result.hostname)) {
    return { ok: false, message: m.add_server_dialog_already_in_list() };
  }
  return { ok: true, hostname: result.hostname };
}

/**
 * Server hinzufügen + Cert-Login (+ optional Community beitreten) + Navigation.
 *
 * @throws SelfHostContactConfirmRequired beim ersten Kontakt (Caller bestätigt
 *         und ruft mit ``confirmed: true`` erneut).
 * @throws CertLoginError — 'join-requires-invite' behandelt der Dialog mit dem
 *         Code-Feld, alles andere via mapCertLoginReason.
 */
export async function joinServerByHost(
  hostname: string,
  code: string | undefined,
  confirmed: boolean,
): Promise<void> {
  if (!confirmed && !selfHostContactConfirmed(hostname)) {
    throw new SelfHostContactConfirmRequired(hostname);
  }
  markSelfHostContactConfirmed(hostname);

  const { entry, invite, inviteError } = await addServerWithCertLogin({
    hostname,
    inviteCode: code,
    communityGrantCode: code,
  });
  markSelfHostDisclaimerSeen(hostname, entry.id);
  // Server hinzugefügt, aber der Community-Beitritt scheiterte (z.B. Code
  // inzwischen abgelaufen): Server bleibt, der User erfährt den Grund.
  if (inviteError) toast.error(m.add_server_flow_invite_failed(), { description: inviteError });
  if (code && invite?.guild?.id) joinedInvites.markJoined(code, invite.guild.id);

  activeServer.set(entry.id);
  await guilds.hydrate();
  // Pro-Server-Gildenliste explizit seeden, damit Membership-abhängige UI den
  // Beitritt sofort sieht (wie der Invite-Pfad in joinByInvite.ts).
  await serverGuilds.refresh(entry.id);
  if (invite?.guild?.id) {
    await goto(
      invite.channel_id
        ? `/app/guilds/${invite.guild.id}/channels/${invite.channel_id}`
        : `/app/guilds/${invite.guild.id}/channels/_`,
    );
  } else {
    await goto('/app');
  }
}
