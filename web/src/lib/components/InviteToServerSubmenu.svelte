<!--
  Submenu rendered inside PopoverFriendActions when the user clicks
  "Zu Server einladen". Lists ALL communities the caller belongs to across
  every joined server — the active server's (permission-checked via the
  seeded roles) plus those of the OTHER servers (serverGuilds REST-Cache;
  CREATE_INVITES ist Default-Mitgliedschaftsrecht, der Backend-Guard fängt
  den Ausnahmefall per 403 ab) — AUSSER solche, in denen der Freund bereits
  Mitglied ist (2026-09-11: ein Angebot, das der Server ohnehin mit 409
  already_member quittiert, verwirrt nur). Clicking one sends a Community-
  Invite (Stufe 3) statt einem Roh-Link per DM.

  Cross-Server (Nutzerwunsch 2026-09-18): die Liste war bisher auf den
  AKTIVEN Server begrenzt — auf der Cloud tauchte keine Self-Host-Community
  auf. Jetzt mintet createInvite auf dem Server der Community (Route-
  Parameter) und der Broker-Eintrag trägt dessen Hostname/instance_id als
  target_host — die Empfänger-Karte im Freunde-Tab kann das seit jeher
  (Erstkontakt-Gate inklusive).

  Flow:
    1. chatApi.createInvite(guild.id, {…}, { serverId }) → host-Invite-Code
       auf dem Server, zu dem die Community gehört
    2. communityInvitesApi.create({...}) → Cloud-Broker
-->
<script lang="ts">
  import { guilds } from '$lib/stores/guilds.svelte';
  import { anfangsBuchstabe } from '$lib/utils/anfangsBuchstabe';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { chatApi } from '$lib/api/chat';
  import { communityInvitesApi } from '$lib/api/community-invites';
  import { toast } from 'svelte-sonner';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import type { Guild, Member } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import MenuRow from '$lib/components/menu/MenuRow.svelte';
  import { guildIconSrc } from '$lib/guildIcon';
  import { memberListCache } from './MentionAutocomplete.svelte';

  let {
    friendUserId,
    friendName,
    onDone
  }: {
    friendUserId: string;
    friendName: string;
    onDone: () => void;
  } = $props();

  let working = $state(false);

  /** Ein anbietbares Ziel: Community + der Server, auf dem sie lebt. */
  type Ziel = {
    // Schlüssel MIT Server-Id: Snowflakes verschiedener Instanzen können
    // zahlen kollidieren — eine Guild-Id allein ist nicht eindeutig.
    key: string;
    guild: Guild;
    serverId: string;
    serverHostname: string;
    instanceId: string | null;
    /** true = aktiver Server (Rechte sind über die Rollen geprüft). */
    aktiv: boolean;
  };

  // Aktiver Server: unverändert — permission-geprüft über die geseedeten Rollen.
  let aktiveZiele = $derived.by<Ziel[]>(() => {
    const sid = activeServer.serverId;
    const srv = activeServer.current;
    return guilds.list
      .filter((g: Guild) => roles.hasGuildPermission(g.id, Perm.CREATE_INVITES))
      .map((g: Guild) => ({
        key: `${sid}:${g.id}`,
        guild: g,
        serverId: sid,
        serverHostname: srv?.hostname ?? '',
        instanceId: srv?.instance_id ?? null,
        aktiv: true
      }));
  });

  // Übrige Server: Gildenlisten per REST (serverGuilds-Cache). Ein nicht
  // erreichbarer Self-Host fällt still weg (allSettled + schluckendes ensureLoaded).
  let remoteZiele = $state<Ziel[]>([]);

  $effect(() => {
    const fremde = serversStore.servers.filter((s) => s.id !== activeServer.serverId);
    if (fremde.length === 0) {
      remoteZiele = [];
      return;
    }
    let cancelled = false;
    void Promise.allSettled(
      fremde.map(async (s) => {
        await serverGuilds.ensureLoaded(s.id);
        return serverGuilds.get(s.id).map(
          (g): Ziel => ({
            key: `${s.id}:${g.id}`,
            guild: g,
            serverId: s.id,
            serverHostname: s.hostname,
            instanceId: s.instance_id ?? null,
            aktiv: false
          })
        );
      })
    ).then((ergebnisse) => {
      if (cancelled) return;
      remoteZiele = ergebnisse
        .filter((r): r is PromiseFulfilledResult<Ziel[]> => r.status === 'fulfilled')
        .flatMap((r) => r.value);
    });
    return () => {
      cancelled = true;
    };
  });

  let ziele = $derived([...aktiveZiele, ...remoteZiele]);

  // Communitys, in denen der Freund schon Mitglied ist — sie verschwinden
  // aus der Liste. Aktive Server über memberListCache (teilt den Fetch mit
  // MemberList/Mention-Autocomplete), fremde Server über einen gerouteten
  // Fetch mit Instanz-Cache. Ein Cache-/Fetch-Fehler lässt die Community
  // sichtbar: der Backend-Guard (409 already_member) fängt den Restfall auf.
  let friendGuildKeys = $state<Set<string>>(new Set());
  const fremdeMitglieder = new Map<string, Promise<Member[]>>();

  function mitgliederVon(z: Ziel): Promise<Member[]> {
    if (z.aktiv) return memberListCache.get(z.guild.id);
    let p = fremdeMitglieder.get(z.key);
    if (!p) {
      p = chatApi.listMembers(z.guild.id, { serverId: z.serverId });
      fremdeMitglieder.set(z.key, p);
      p.catch(() => fremdeMitglieder.delete(z.key));
    }
    return p;
  }

  $effect(() => {
    const alle = ziele;
    if (alle.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(
      alle.map(async (z) =>
        (await mitgliederVon(z)).some((mitglied) => mitglied.user_id === friendUserId)
          ? z.key
          : null
      )
    ).then((ergebnisse) => {
      if (cancelled) return;
      friendGuildKeys = new Set(
        ergebnisse
          .filter(
            (r): r is PromiseFulfilledResult<string> =>
              r.status === 'fulfilled' && r.value !== null
          )
          .map((r) => r.value)
      );
    });
    return () => {
      cancelled = true;
    };
  });

  let anbietbareZiele = $derived(ziele.filter((z) => !friendGuildKeys.has(z.key)));

  function hostKurz(hostname: string): string {
    return hostname.replace(/^https?:\/\//, '');
  }

  async function sendInvite(ziel: Ziel) {
    if (working) return;
    working = true;
    try {
      // Vorbedingung VOR dem Minten (Bughunt 2026-09-20, Runde 2): ohne
      // Ziel-Host fehlt dem Broker der Routing-Key (Backend verlangt
      // target_host non-empty → sonst 422). Vorher wurde erst der
      // Single-Use-Invite gemintet und dann abgebrochen — der Code blieb
      // als verwaiste Zeile in der Einladungsliste liegen.
      if (!ziel.serverHostname) {
        toast.error(m.invite_to_server_submenu_invite_error());
        return;
      }
      // 1. Frischen host-Invite-Code minten (single-use, 24h) — AUF DEM
      //    SERVER der Community, nicht auf dem gerade aktiven.
      const invite = await chatApi.createInvite(
        ziel.guild.id,
        { maxUses: 1, expiresInSeconds: 86400 },
        { serverId: ziel.serverId }
      );
      // 2. Community-Invite über den Cloud-Broker schicken. target_host ist
      //    der Server DER COMMUNITY — der Empfänger soll ja genau dorthin
      //    eingeladen werden (Cross-Server: Freund in der Cloud, Community
      //    auf dem Self-Host).
      await communityInvitesApi.create({
        invitee_id: friendUserId,
        target_host: ziel.serverHostname,
        target_instance_id: ziel.instanceId,
        target_guild_id: ziel.guild.id,
        target_guild_name: ziel.guild.name,
        code: invite.code
      });
      toast.success(m.invite_to_server_submenu_invite_sent({ friendName }));
      onDone();
    } catch (e) {
      toast.error(m.invite_to_server_submenu_invite_error(), {
        description: (e as Error).message
      });
    } finally {
      working = false;
    }
  }
</script>

<div class="mt-1 flex flex-col gap-1" data-testid="invite-to-server-submenu">
  {#if anbietbareZiele.length === 0}
    <p class="text-text-muted px-3 py-2 text-xs">
      {m.invite_to_server_submenu_no_invitable_guilds()}
    </p>
  {:else}
    {#each anbietbareZiele as ziel (ziel.key)}
      {@const iconSrc = guildIconSrc(ziel.guild.icon_url, ziel.serverHostname)}
      <MenuRow
        onclick={() => sendInvite(ziel)}
        disabled={working}
        data-testid="invite-guild-btn"
      >
        <Avatar.Root class="size-6 shrink-0">
          {#if iconSrc}
            <Avatar.Image src={iconSrc} alt={ziel.guild.name} />
          {/if}
          <Avatar.Fallback class="accent-gradient text-primary-foreground text-xs font-semibold">
            {anfangsBuchstabe(ziel.guild.name)}
          </Avatar.Fallback>
        </Avatar.Root>
        <span class="truncate">{ziel.guild.name}</span>
        {#if !ziel.aktiv}
          <span class="text-text-muted ml-auto truncate text-2xs" title={ziel.serverHostname}>
            {hostKurz(ziel.serverHostname)}
          </span>
        {/if}
      </MenuRow>
    {/each}
  {/if}
</div>
