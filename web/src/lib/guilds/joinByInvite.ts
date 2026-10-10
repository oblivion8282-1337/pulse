import { goto } from '$app/navigation';
import { m } from '$lib/paraglide/messages.js';
import { chatApi } from '$lib/api/chat';
import { rolesApi } from '$lib/api/roles';
import { guilds } from '$lib/stores/guilds.svelte';
import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { serversStore, CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import {
  addServerWithCertLogin,
  acceptInvite,
  SelfHostContactConfirmRequired,
  selfHostContactConfirmed,
  markSelfHostContactConfirmed,
} from '$lib/api/add-server-flow';
import { zielHost } from '$lib/einladung/einladungsLink';
import { beitrittsEingabeZerlegen, type ParsedJoinInput } from './beitrittsEingabe';
import { holeTicket, loeseTicketEin } from '$lib/api/server-ticket';

import { instancesApi } from '$lib/api/instances';
import { sessionTokens } from '$lib/api/session_tokens.svelte';
import { joinedInvites } from '$lib/stores/joinedInvites.svelte';

/**
 * Meldet sich an einem bereits bekannten Self-Host neu an — mit einem Zugang.
 *
 * Warum das nötig ist: Ein Server kann in der Liste stehen, ohne dass eine
 * Mitgliedschaft besteht (Phantom-Eintrag). Die Anmeldung MIT dem Code heilt
 * das (idempotent, falls schon Mitglied), und erst danach greift der Beitritt
 * zur Community selbst.
 */
async function anmeldenMitZugang(
  server: { id: string; hostname: string; instance_id?: string | null },
  zugang: { communityGrantCode?: string; publicJoinHandle?: string },
): Promise<string | null> {
  // Hostname, nicht Kennung — die Cloud loest auf. Den fremden Server danach zu
  // fragen waere die Luecke, gegen die dieser Weg gebaut ist.
  const { ticket, instanceId } = await holeTicket(server.hostname);
  // Mitgliedschaft VOR dem Dial tragen: Telefonbuch-Lookup und Offer sind
  // membership-gated (die Heim-IP heikel), und ein Einladungsinhaber ist vor
  // dem Redeem noch kein Mitglied — ohne diesen Schritt Henne-Ei: der
  // Beitritt braucht den Tunnel, der Tunnel die Mitgliedschaft (Mac-Zwei-
  // User-E2E 2026-09-28). Nachweisfrei, wie die Cloud die Vermerkung ohnehin
  // haelt (s. routes_instance_membership.py); die echte Schranke bleibt der
  // Invite-Code beim Redeem auf dem Server dahinter. Best-effort: schlaegt
  // der Eintrag fehl, scheitert der Dial sichtbar wie bisher.
  if (instanceId) {
    await instancesApi.joinInstanceMembership(instanceId).catch(() => undefined);
  }
  const sitzung = await loeseTicketEin(server, ticket, zugang);
  sessionTokens.set(server.id, sitzung.session_token, Date.now() + sitzung.expires_in * 1000);
  return instanceId;
}

/** Trägt die Cloud-Membership ein, damit der per Einladung beigetretene
 *  Self-Host-Server auch im Browser / auf anderen Geräten sichtbar wird.
 *  Best-effort: ein Fehler darf den Beitritt nicht stören (der Reauth-Backfill
 *  holt es nach). */
function syncInstanceMembership(instanceId: string | null | undefined): void {
  if (!instanceId) return;
  void instancesApi.joinInstanceMembership(instanceId).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/** Zerlegt die Eingabe des Beitrittsfelds; die Rechnung steht importfrei in
 *  beitrittsEingabe.ts (dort auch die erkannten Formate). */
export function parseJoinInput(input: string): ParsedJoinInput {
  return beitrittsEingabeZerlegen(input, CLOUD_HOSTNAME);
}

// ---------------------------------------------------------------------------
// Navigation-Helfer nach Beitritt
// ---------------------------------------------------------------------------

async function navigateAfterJoin(
  guildId: string,
  channelId: string | null | undefined,
): Promise<void> {
  await guilds.hydrate();
  if (channelId) {
    await goto(`/app/guilds/${guildId}/channels/${channelId}`);
  } else {
    await goto(`/app/guilds/${guildId}/channels/_`);
  }
}

// ---------------------------------------------------------------------------
// Public-Community-Join-Logik
// ---------------------------------------------------------------------------

/**
 * Tritt einer öffentlichen Community bei (handle-basiert).
 *
 * - Cloud-Ziel (host=null oder Cloud-Host): direkt ``joinPublicCommunity``.
 * - Self-Host: Disclaimer-Gate + Server-Add + cert-login mit ``publicJoinHandle``
 *   + ``joinPublicCommunity`` auf dem neuen Server.
 *
 * @throws SelfHostContactConfirmRequired wenn der Host unbekannt und nicht bestätigt.
 */
async function joinByPublicHandle(
  handle: string,
  host: string | null,
  confirmed: boolean,
): Promise<void> {
  const ziel = zielHost(host, CLOUD_HOSTNAME);
  if (ziel === undefined) throw new Error(m.einladung_host_ungueltig());
  if (!ziel) {
    // Cloud-Community — ausdrücklich an die Cloud, wie im Invite-Pfad.
    const cloudId = serversStore.cloudId();
    const result = await chatApi.joinPublicCommunity(handle, cloudId ? { serverId: cloudId } : {});
    if (cloudId) activeServer.set(cloudId);
    await navigateAfterJoin(result.guild.id, result.channel_id);
    return;
  }

  const hostname = `https://${ziel}`;

  const existing = serversStore.findByHostname(hostname);
  if (existing) {
    // Server bereits bekannt — aber evtl. ohne echte Mitgliedschaft (Phantom-
    // Eintrag). Wie im Invite-Pfad: ZUERST anmelden MIT dem ``public_join_handle``
    // (gewährt Mitgliedschaft, falls die Community öffentlich ist; idempotent,
    // falls schon Mitglied), DANN joinPublicCommunity.
    const instanzId = await anmeldenMitZugang(existing, { publicJoinHandle: handle });
    syncInstanceMembership(instanzId ?? existing.instance_id);
    const result = await chatApi.joinPublicCommunity(handle, { serverId: existing.id });
    activeServer.set(existing.id);
    await navigateAfterJoin(result.guild.id, result.channel_id);
    return;
  }

  // Erstkontakt-Gate
  if (!confirmed && !selfHostContactConfirmed(hostname)) {
    throw new SelfHostContactConfirmRequired(hostname);
  }
  markSelfHostContactConfirmed(hostname);

  // Neuer Server: hinzufügen + cert-login mit publicJoinHandle
  const { entry } = await addServerWithCertLogin({
    hostname,
    publicJoinHandle: handle,
  });
  activeServer.set(entry.id);
  const result = await chatApi.joinPublicCommunity(handle, { serverId: entry.id });
  await navigateAfterJoin(result.guild.id, result.channel_id);
}

// ---------------------------------------------------------------------------
// Haupt-API
// ---------------------------------------------------------------------------

/**
 * Accept an invite or join a public community (given a pasted link, a bare
 * code, or a public community address `<host>/c/<handle>`).
 *
 * Throws on empty input, invalid/expired code (ApiError), or network errors —
 * callers should surface those to the user.
 *
 * Self-Host (unbekannt): wirft ``SelfHostContactConfirmRequired`` bei erstem
 * Kontakt; der Caller zeigt den Dialog und ruft mit ``confirmed: true`` erneut.
 */
export async function joinGuildByInvite(input: string, confirmed = false): Promise<void> {
  const parsed = parseJoinInput(input);
  if (!input.trim()) throw new Error(m.einladung_beitritt_eingabe());

  if (parsed.kind === 'public') {
    return joinByPublicHandle(parsed.handle, parsed.host, confirmed);
  }

  if (parsed.kind === 'host') {
    // Nackte Hostadressen laufen über den interaktiven Host-Flow des
    // Join-Dialogs (joinByHost.ts — Pre-Check, Erstkontakt, ggf. Code-Nachfrage).
    // Dieser Pfad hier ist fire-and-forget und kann das nicht abbilden.
    throw new Error(m.join_input_host_use_dialog());
  }

  // --- Invite-Code-Pfad (unveränderte Logik) ---
  const { code } = parsed;
  if (!code) throw new Error(m.einladung_beitritt_eingabe());
  // Zielserver streng prüfen (einladungsLink.ts): `?host=<cloud>` ist eine
  // Cloud-Einladung; ein Host mit `@`, `\`, Port oder IP wird abgewiesen —
  // daran lesen Browser und Cloud (Python) eine Adresse verschieden.
  const host = zielHost(parsed.host, CLOUD_HOSTNAME);
  if (host === undefined) throw new Error(m.einladung_host_ungueltig());

  if (host) {
    const hostname = `https://${host}`;

    let serverId: string;
    const existing = serversStore.findByHostname(hostname);
    if (existing) {
      // Server bekannt — ABER der lokale Eintrag kann existieren, OHNE dass wir
      // wirklich Instanz-Mitglied sind (Phantom-Eintrag aus einem abgebrochenen
      // Erst-Join oder einem Account-Switch-Leak). ``acceptInvite`` braucht aber
      // eine gültige Session, und der cert-login mintet die nur, wenn wir schon
      // Mitglied sind ODER ein Grant-Code die Mitgliedschaft gewährt. Darum hier
      // ZUERST eine Anmeldung MIT dem ``community_grant_code`` (heilt den
      // Phantom-Eintrag; idempotent, falls schon Mitglied → member-Pfad im Gate),
      // DANN acceptInvite. Ohne das scheitert ein Beitritt über einen bereits
      // gelisteten Self-Host mit ``join_not_permitted``.
      serverId = existing.id;
      const instanzId = await anmeldenMitZugang(existing, { communityGrantCode: code });
      syncInstanceMembership(instanzId ?? existing.instance_id);
      const result = await acceptInvite(code, { serverId });
      joinedInvites.markJoined(code, result.guild.id);
      // Aktiven Server auf den Self-Host umschalten BEVOR wir dorthin
      // navigieren (wie der public-handle-Pfad) — sonst routen WS/API-Calls,
      // die auf activeServer.current zurückfallen, weiter zum vorigen Server
      // (z.B. Cloud) und die Self-Host-Gilde rendert/sendet gegen den falschen.
      activeServer.set(serverId);
      await guilds.hydrate();
      // Pro-Server-Gildenliste zusätzlich explizit neu laden, damit
      // Membership-abhängige UI (z.B. die InviteEmbed-Karte) den Beitritt
      // sofort sieht, falls der activeServer-Bridge-Sync noch nicht griff.
      await serverGuilds.refresh(serverId);
      if (result.channel_id) {
        await goto(`/app/guilds/${result.guild.id}/channels/${result.channel_id}`);
      } else {
        await goto(`/app/guilds/${result.guild.id}/channels/_`);
      }
    } else {
      // Erstkontakt-Gate: neuer, unbekannter Self-Host → bestätigen lassen, BEVOR
      // die Cert-Challenge gegen den Host geschickt wird (Metadaten-Leak-Schutz).
      if (!confirmed && !selfHostContactConfirmed(hostname)) {
        throw new SelfHostContactConfirmRequired(hostname);
      }
      markSelfHostContactConfirmed(hostname);
      // Neuer Server: hinzufügen + cert-login + invite.
      // WICHTIG: Bei einem Self-Host-Community-Invite dient derselbe Code
      // ZUGLEICH als `community_grant_code` (gewährt die community-scoped
      // Instanz-Mitgliedschaft im cert-login/verify) UND als `inviteCode`
      // (Guild-Beitritt via POST /invites/{code}/accept). Ohne den Grant
      // scheitert der cert-login beim Erstkontakt mit 403 (join-requires-invite).
      const { entry, invite } = await addServerWithCertLogin({
        hostname,
        inviteCode: code,
        communityGrantCode: code,
      });
      serverId = entry.id;
      if (invite?.guild?.id) joinedInvites.markJoined(code, invite.guild.id);
      activeServer.set(serverId);
      await guilds.hydrate();
      // Wie oben: Pro-Server-Liste seeden, damit die Karte sofort „Beigetreten"
      // zeigt (deckt auch den Fall ab, dass der Bridge-Sync noch nicht lief).
      await serverGuilds.refresh(serverId);
      if (invite?.channel_id) {
        await goto(`/app/guilds/${invite.guild.id}/channels/${invite.channel_id}`);
      } else if (invite?.guild?.id) {
        await goto(`/app/guilds/${invite.guild.id}/channels/_`);
      } else {
        await goto('/app');
      }
    }
    return;
  }

  // Cloud-Einladung AUSDRÜCKLICH an die Cloud: ist gerade ein Self-Host
  // aktiv, kennt der den Code nicht und antwortete 404 „ungültig“.
  const cloudId = serversStore.cloudId();
  const result = cloudId
    ? await acceptInvite(code, { serverId: cloudId })
    : await chatApi.acceptInvite(code);
  if (cloudId) activeServer.set(cloudId);
  joinedInvites.markJoined(code, result.guild.id);
  await guilds.hydrate();
  // Pull roles for the newly-joined guild so UI gates resolve correctly
  // before the next WS reconnect rebuilds ``ready``. recomputeGuild
  // runs after upsert so the @everyone permissions feed the resolver.
  try {
    const rows = await rolesApi.list(result.guild.id);
    for (const r of rows) roles.upsertRole(r);
    roles.recomputeGuild(result.guild.id);
  } catch {
    /* best-effort; the user sees the guild listed either way */
  }
  // Pull this guild's sound overrides for the same reason — without it
  // the voice/notification sounds use defaults until WS reconnect.
  guildSounds.ensureSlot(result.guild.id);
  void guildSounds.refresh(result.guild.id);
  await goto(
    result.channel_id
      ? `/app/guilds/${result.guild.id}/channels/${result.channel_id}`
      : `/app/guilds/${result.guild.id}/channels/_`
  );
}
