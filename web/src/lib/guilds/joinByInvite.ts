import { goto } from '$app/navigation';
import { chatApi } from '$lib/api/chat';
import { rolesApi } from '$lib/api/roles';
import { guilds } from '$lib/stores/guilds.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { serversStore } from '$lib/api/servers.svelte';
import { activeServer } from '$lib/stores/active-server.svelte';
import {
  addServerWithCertLogin,
  acceptInvite,
  SelfHostContactConfirmRequired,
  selfHostContactConfirmed,
  markSelfHostContactConfirmed,
} from '$lib/api/add-server-flow';

/**
 * Zerlegt einen gepasteten Link ODER bare Code in ``{ code, host }``.
 * ``host`` ist der bare FQDN aus ``?host=`` (oder null bei Cloud/bare Code).
 */
function parseInviteInput(input: string): { code: string; host: string | null } {
  const trimmed = input.trim();
  const codeMatch = trimmed.match(/\/invite\/([^/?#\s]+)/i);
  const code = (codeMatch ? codeMatch[1] : trimmed).trim();
  const hostMatch = trimmed.match(/[?&]host=([^\s&#]+)/i);
  const host = hostMatch ? decodeURIComponent(hostMatch[1]) : null;
  return { code, host };
}

/**
 * Accept an invite (given a pasted link or a bare code), refresh the guild
 * list, and navigate into the joined guild. Throws on an empty input or an
 * invalid/expired code (ApiError) — callers should surface that to the user.
 *
 * Self-Host (Link trägt ``?host=``): Cert-Login + Invite-Accept direkt.
 *
 * **Sicherheits-Gate:** Bei einem **neuen, unbekannten** Self-Host wird VOR dem
 * ersten Kontakt `SelfHostContactConfirmRequired` geworfen (solange `confirmed`
 * nicht true ist und der Host nicht früher bestätigt wurde). Der Caller zeigt
 * den Bestätigungs-Dialog und ruft mit `confirmed: true` erneut auf.
 */
export async function joinGuildByInvite(input: string, confirmed = false): Promise<void> {
  const { code, host } = parseInviteInput(input);
  if (!code) throw new Error('Bitte einen Einladungslink oder -code eingeben.');

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
      // Neuer Server: hinzufügen + cert-login + invite
      const { entry, invite } = await addServerWithCertLogin({
        hostname,
        inviteCode: code,
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
