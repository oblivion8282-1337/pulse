import { goto } from '$app/navigation';
import { chatApi } from '$lib/api/chat';
import { rolesApi } from '$lib/api/roles';
import { guilds } from '$lib/stores/guilds.svelte';
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

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Ergebnis des Parsens eines Join-Inputs.
 * Genau eines von ``inviteCode`` ODER ``publicHandle`` ist gesetzt.
 */
type ParsedInput =
  | { kind: 'invite'; code: string; host: string | null }
  | { kind: 'public'; handle: string; host: string | null };

/**
 * Zerlegt einen gepasteten Link oder bare Code in sein strukturiertes Format.
 *
 * Erkannte Formate:
 *  - Einladungslink: `<any>/invite/<code>[?host=<fqdn>]`
 *  - Öffentliche Community-Adresse: `<any>/c/<handle>[?host=<fqdn>]`
 *  - Bare Community-Handle: `c/<handle>` (kein Leading-Slash nötig)
 *  - Bare Invite-Code: alles andere (Fallback)
 *
 * ``host`` ist der bare FQDN aus ``?host=`` (oder null bei Cloud/bare Code).
 */
function parseJoinInput(input: string): ParsedInput {
  const trimmed = input.trim();

  // Öffentliche Community-Adresse: <scheme://host>/c/<handle>[?...]
  // oder bare c/<handle>
  const publicMatch = trimmed.match(/(?:^|\/)(c)\/([a-z0-9][a-z0-9-]{0,30}[a-z0-9]|[a-z0-9])(?:[/?#]|$)/i);
  if (publicMatch) {
    const handle = publicMatch[2].toLowerCase();
    // Extrahiere den Host aus der URL (falls vorhanden, z.B. https://chat.firma.de/c/meine-community)
    let host: string | null = null;
    const hostParam = trimmed.match(/[?&]host=([^\s&#]+)/i);
    if (hostParam) {
      host = decodeURIComponent(hostParam[1]);
    } else {
      // Host aus dem URL-Schema extrahieren (wenn URL mit http(s):// beginnt)
      const urlHostMatch = trimmed.match(/^https?:\/\/([^/]+)\//i);
      if (urlHostMatch && !trimmed.includes(CLOUD_HOSTNAME.replace('https://', ''))) {
        const extractedHost = urlHostMatch[1];
        // Nur als Self-Host behandeln, wenn es NICHT der Cloud-Host ist
        const cloudHost = CLOUD_HOSTNAME.replace('https://', '').replace('http://', '');
        if (extractedHost !== cloudHost) {
          host = extractedHost;
        }
      }
    }
    return { kind: 'public', handle, host };
  }

  // Einladungslink: <any>/invite/<code>[?host=<fqdn>]
  const codeMatch = trimmed.match(/\/invite\/([^/?#\s]+)/i);
  const code = (codeMatch ? codeMatch[1] : trimmed).trim();
  const hostMatch = trimmed.match(/[?&]host=([^\s&#]+)/i);
  const host = hostMatch ? decodeURIComponent(hostMatch[1]) : null;
  return { kind: 'invite', code, host };
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
  if (!host) {
    // Cloud-Community
    const result = await chatApi.joinPublicCommunity(handle);
    await navigateAfterJoin(result.guild.id, result.channel_id);
    return;
  }

  const trimmed = host.trim().toLowerCase().replace(/\/$/, '');
  const hostname = trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;

  const existing = serversStore.findByHostname(hostname);
  if (existing) {
    // Server bereits bekannt → nur beitreten
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
  if (!input.trim()) throw new Error('Bitte einen Einladungslink, -code oder eine Community-Adresse eingeben.');

  if (parsed.kind === 'public') {
    return joinByPublicHandle(parsed.handle, parsed.host, confirmed);
  }

  // --- Invite-Code-Pfad (unveränderte Logik) ---
  const { code, host } = parsed;
  if (!code) throw new Error('Bitte einen Einladungslink, -code oder eine Community-Adresse eingeben.');

  if (host) {
    // Self-Host: HTTPS-Hostname normalisieren
    const trimmed = host.trim().toLowerCase().replace(/\/$/, '');
    const hostname = trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;

    let serverId: string;
    const existing = serversStore.findByHostname(hostname);
    if (existing) {
      // Server bekannt: Invite direkt dort akzeptieren
      serverId = existing.id;
      const result = await acceptInvite(code, { serverId });
      await guilds.hydrate();
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
      activeServer.set(serverId);
      await guilds.hydrate();
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

  const result = await chatApi.acceptInvite(code);
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
