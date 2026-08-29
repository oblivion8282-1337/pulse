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
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { userCache, type UserSummary } from '$lib/stores/users.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { chatApi } from '$lib/api/chat';
  import { request } from '$lib/api/client';
  import { safeAvatarUrl } from '$lib/avatar';
  import { m } from '$lib/paraglide/messages.js';

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

  type VoiceChannelRow = {
    id: string;
    name: string;
    userIds: string[];
    /** LIVE = Screen-Share ∪ HQ-Stream (gleiche Union wie `VoiceChannelMembers`). */
    streamingUserIds: string[];
    /** User mit Webcam an (server-seitig via LiveKit-Webhook gepflegt). */
    camUserIds: string[];
    /** Watch-Party-Hosts in diesem Channel (mehrere Parties möglich). */
    partyHostUserIds: string[];
  };

  let isRemote = $derived(serverId !== null && serverId !== activeServer.serverId);

  // --- Remote-Pfad: REST-Snapshot gegen den nicht-aktiven Server ----------
  let remoteChannels = $state<VoiceChannelRow[]>([]);

  $effect(() => {
    if (!isRemote || !serverId) return;
    const sid = serverId;
    const gid = guildId;
    void (async () => {
      try {
        // Drei unabhängige Reads parallel — liefert User, Screen-Share/Cam und
        // HQ-Streamer/Watch-Party-Hosts. Alles VIEW_CHANNEL-gefiltert (Backend).
        const [channels, vs, ss, ws] = await Promise.all([
          chatApi.listChannels(gid, { serverId: sid }),
          chatApi.guildVoiceState(gid, { serverId: sid }),
          chatApi.guildStreamState(gid, { serverId: sid }),
          chatApi.guildWatchState(gid, { serverId: sid })
        ]);
        const voiceByCh = new Map(vs.voice_states.map((s) => [s.channel_id, s]));
        const hqByCh = new Map(ss.stream_states.map((s) => [s.channel_id, s.user_ids]));
        const partyHostsByCh = new Map<string, string[]>();
        for (const w of ws.watch_states) {
          const arr = partyHostsByCh.get(w.channel_id) ?? [];
          arr.push(w.state.host_user_id);
          partyHostsByCh.set(w.channel_id, arr);
        }
        const rows: VoiceChannelRow[] = [];
        for (const c of channels) {
          if (c.type !== 1) continue;
          const v = voiceByCh.get(c.id);
          const userIds = v?.user_ids ?? [];
          if (userIds.length === 0) continue;
          rows.push({
            id: c.id,
            name: c.name,
            userIds,
            streamingUserIds: [
              ...new Set([...(v?.streaming_user_ids ?? []), ...(hqByCh.get(c.id) ?? [])])
            ],
            camUserIds: v?.camera_user_ids ?? [],
            partyHostUserIds: partyHostsByCh.get(c.id) ?? []
          });
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
      if (userIds.length === 0) continue;
      out.push({
        id: c.id,
        name: c.name,
        userIds,
        // LIVE = Screen-Share ∪ HQ-Stream (spiegelt ChannelList.svelte).
        streamingUserIds: [
          ...new Set([...voicePresence.streamingIn(c.id), ...streamPresence.streamersIn(c.id)])
        ],
        camUserIds: voicePresence.cameraIn(c.id),
        partyHostUserIds: watchPartyPresence.hostIdsIn(c.id)
      });
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
        class="bg-primary/15 text-primary ml-auto flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold"
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
        {@const liveSet = new Set(ch.streamingUserIds)}
        {@const camSet = new Set(ch.camUserIds)}
        {@const partySet = new Set(ch.partyHostUserIds)}
        <div class="flex flex-col gap-1">
          <!-- Channel-Kopf -->
          <span
            class="text-text-muted flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide"
          >
            <Volume2Icon class="size-3 shrink-0" />
            <span class="truncate">{ch.name}</span>
          </span>
          <!-- User im Channel -->
          <ul class="flex flex-col gap-1 pl-0.5">
            {#each ch.userIds as id (id)}
              {@const avatarUrl = safeAvatarUrl(userCache.get(id)?.avatar_url)}
              {@const display = userCache.displayName(id)}
              {@const isLive = liveSet.has(id)}
              {@const isCam = camSet.has(id)}
              {@const isParty = partySet.has(id)}
              <li class="flex items-center gap-2">
                <Avatar.Root class="size-5 shrink-0">
                  {#if avatarUrl}
                    <Avatar.Image src={avatarUrl} alt="" />
                  {/if}
                  <Avatar.Fallback
                    class="accent-gradient text-primary-foreground text-2xs font-semibold"
                  >
                    {display.slice(0, 1).toUpperCase()}
                  </Avatar.Fallback>
                </Avatar.Root>
                <span class="text-text-base truncate text-xs">{display}</span>
                {#if isLive || isCam || isParty}
                  <!-- Statische Indikator-Pills (nicht klickbar): der Tooltip
                       verschwindet beim Verlassen des Icons, Klickziele darin
                       sind unzuverlässig. Zum Mitmachen Community anklicken.
                       Stil identisch zur Member-Liste (VoiceChannelMembers). -->
                  <span class="ml-auto flex shrink-0 items-center gap-1">
                    {#if isParty}
                      <span
                        class="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-2xs font-bold uppercase text-amber-400"
                        title={m.voice_channel_members_watch_party_hosting()}
                      ><span class="size-1.5 rounded-full bg-amber-400"></span>PARTY</span>
                    {/if}
                    {#if isLive}
                      <span
                        class="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-2xs font-bold uppercase text-red-400"
                        title={m.voice_channel_members_stream_sharing_screen()}
                      ><span class="size-1.5 rounded-full bg-red-400"></span>LIVE</span>
                    {/if}
                    {#if isCam}
                      <span
                        class="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-2xs font-bold uppercase text-cyan-400"
                        title={m.voice_channel_members_cam_on()}
                      ><span class="size-1.5 rounded-full bg-cyan-400"></span>CAM</span>
                    {/if}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  {/if}
</div>
