<!--
  GuildVoiceTooltip — Inhalt des Server-Icon-Tooltips in der GuildRail.

  Zeigt den Servernamen und — falls jemand in einem Voice-Channel des
  Servers sitzt — pro Channel die User darin (Discord-artiges Popout mit
  Avataren).

  Zwei Datenpfade:
  - **Aktiver Server**: Voice-Presence kommt rail-weit aus dem `ready`-Frame
    + `voice_state`-WS-Events (live, auch für gerade nicht geöffnete
    Communitys).
  - **Nicht-aktiver Server** (`serverId` ≠ aktiver Server): die Stores halten
    nur Daten des aktiv verbundenen Servers, daher holt der Tooltip beim
    Mounten einen REST-Snapshot (`listChannels` + `guildVoiceState`) gegen
    DIESEN Server. Kein Live-Update — der Tooltip mountet pro Hover neu,
    der Snapshot ist also immer frisch genug.

  Nur als Tooltip-Kind verwendet → mountet lazy beim Hovern; die User-Namen
  werden erst dann nachgeladen (userCache batcht/debounct das; für fremde
  Server direkt gegen deren `/users`-Endpoint).
-->
<script lang="ts">
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { userCache, type UserSummary } from '$lib/stores/users.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { chatApi } from '$lib/api/chat';
  import { request } from '$lib/api/client';
  import { safeAvatarUrl } from '$lib/avatar';

  let {
    guildId,
    name,
    serverId = null,
    serverLabel = null
  }: {
    guildId: string;
    name: string;
    /** Server, auf dem die Community liegt. Weicht er vom aktiven Server ab,
     *  kommen die Daten per REST-Snapshot statt aus den Live-Stores. */
    serverId?: string | null;
    /** Untertitel (Server-Name) — gesetzt für nicht-aktive Server-Sektionen. */
    serverLabel?: string | null;
  } = $props();

  type VoiceChannelRow = { id: string; name: string; userIds: string[] };

  let isRemote = $derived(serverId !== null && serverId !== activeServer.serverId);

  // --- Remote-Pfad: REST-Snapshot gegen den nicht-aktiven Server ----------
  let remoteChannels = $state<VoiceChannelRow[]>([]);

  $effect(() => {
    if (!isRemote || !serverId) return;
    const sid = serverId;
    const gid = guildId;
    void (async () => {
      try {
        const [channels, vs] = await Promise.all([
          chatApi.listChannels(gid, { serverId: sid }),
          chatApi.guildVoiceState(gid, { serverId: sid })
        ]);
        const occupied = new Map(vs.voice_states.map((s) => [s.channel_id, s.user_ids]));
        const rows: VoiceChannelRow[] = [];
        for (const c of channels) {
          if (c.type !== 1) continue;
          const userIds = occupied.get(c.id) ?? [];
          if (userIds.length > 0) rows.push({ id: c.id, name: c.name, userIds });
        }
        remoteChannels = rows;
        // Namen der fremden Server-User auflösen: deren IDs sind server-lokal,
        // also gegen DENSELBEN Server fragen (Cloud → auth-svc wie üblich).
        const missing = rows.flatMap((r) => r.userIds).filter((id) => !userCache.get(id));
        if (missing.length > 0) {
          const isCloudServer = serversStore.cloudId() === sid;
          const users = await request<UserSummary[]>(
            `/users?ids=${missing.join(',')}`,
            { endpoint: isCloudServer ? 'auth' : 'chat' },
            isCloudServer ? {} : { serverId: sid }
          );
          userCache.seed(users);
        }
      } catch {
        // Server temporär nicht erreichbar (z.B. Cert-Re-Auth steht aus) —
        // Tooltip zeigt dann nur den Community-Namen.
      }
    })();
  });

  // --- Aktiver Pfad: Live-Stores -------------------------------------------
  // Voice-Channels dieses Servers MIT Belegung, je Channel die User-IDs.
  // Voice-Channel = `type === 1`. Leere Channels fallen raus.
  let voiceChannels = $derived.by((): VoiceChannelRow[] => {
    if (isRemote) return remoteChannels;
    const channels = guildsStore.channelsByGuild[guildId] ?? [];
    const out: VoiceChannelRow[] = [];
    for (const c of channels) {
      if (c.type !== 1) continue;
      const userIds = voicePresence.usersIn(c.id);
      if (userIds.length > 0) out.push({ id: c.id, name: c.name, userIds });
    }
    return out;
  });

  let totalInVoice = $derived(
    voiceChannels.reduce((n, ch) => n + ch.userIds.length, 0)
  );

  // Channel-Liste sicherstellen: der `ready`-Frame seedet `voicePresence` für
  // ALLE Communitys, aber `channelsByGuild` füllt sich nur lazy (Prefetch nach
  // Login — fire-and-forget, Fehler verschluckt — oder beim ersten Öffnen).
  // Ohne Channels gibt es nichts, dem die Presence zugeordnet werden kann →
  // der Tooltip blieb leer für Communitys, die man noch nie geöffnet hat.
  // `ensureChannels` dedupet, ist also auch bei jedem Hover billig.
  $effect(() => {
    if (isRemote) return;
    if (!guildsStore.channelsByGuild[guildId]) {
      void guildsStore.ensureChannels(guildId).catch(() => undefined);
    }
  });

  // Namen für noch nicht gecachte User nachladen (batched + debounced).
  // Remote-User werden oben direkt gegen ihren Server aufgelöst.
  $effect(() => {
    if (isRemote) return;
    for (const ch of voiceChannels) {
      for (const id of ch.userIds) userCache.queue(id);
    }
  });
</script>

<div class="flex w-full flex-col gap-2.5" data-testid={`guild-voice-${guildId}`}>
  <!-- Server-Titel -->
  <div class="flex items-center gap-2">
    <span class="text-text-bright truncate text-sm font-semibold">{name}</span>
    {#if totalInVoice > 0}
      <span
        class="bg-primary/15 text-primary ml-auto flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
      >
        <Volume2Icon class="size-2.5" />
        {totalInVoice}
      </span>
    {/if}
  </div>
  {#if serverLabel}
    <span class="text-text-muted -mt-2 text-xs">{serverLabel}</span>
  {/if}

  {#if voiceChannels.length > 0}
    <div class="bg-border h-px w-full" aria-hidden="true"></div>
    <div class="flex flex-col gap-2.5">
      {#each voiceChannels as ch (ch.id)}
        <div class="flex flex-col gap-1">
          <!-- Channel-Kopf -->
          <span
            class="text-text-muted flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide"
          >
            <Volume2Icon class="size-3 shrink-0" />
            <span class="truncate">{ch.name}</span>
          </span>
          <!-- User im Channel -->
          <ul class="flex flex-col gap-1 pl-0.5">
            {#each ch.userIds as id (id)}
              {@const avatarUrl = safeAvatarUrl(userCache.get(id)?.avatar_url)}
              {@const display = userCache.displayName(id)}
              <li class="flex items-center gap-2">
                <Avatar.Root class="size-5 shrink-0">
                  {#if avatarUrl}
                    <Avatar.Image src={avatarUrl} alt="" />
                  {/if}
                  <Avatar.Fallback
                    class="accent-gradient text-primary-foreground text-[9px] font-semibold"
                  >
                    {display.slice(0, 1).toUpperCase()}
                  </Avatar.Fallback>
                </Avatar.Root>
                <span class="text-text-base truncate text-xs">{display}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  {/if}
</div>
