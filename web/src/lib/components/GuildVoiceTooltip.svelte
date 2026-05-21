<!--
  GuildVoiceTooltip — Inhalt des Server-Icon-Tooltips in der GuildRail.

  Zeigt den Servernamen und — falls jemand in einem Voice-Channel des
  Servers sitzt — pro Channel die User darin (Discord-artiges Popout mit
  Avataren). Die Voice-Presence kommt rail-weit aus dem `ready`-Frame +
  `voice_state`-WS-Events, ist also auch für gerade nicht geöffnete Server
  live.

  Nur als Tooltip-Kind verwendet → mountet lazy beim Hovern; die User-Namen
  werden erst dann nachgeladen (userCache batcht/debounct das).
-->
<script lang="ts">
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import * as Avatar from '$lib/components/ui/avatar/index.js';
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { safeAvatarUrl } from '$lib/avatar';

  let { guildId, name }: { guildId: string; name: string } = $props();

  // Voice-Channels dieses Servers MIT Belegung, je Channel die User-IDs.
  // Voice-Channel = `type === 1`. Leere Channels fallen raus.
  let voiceChannels = $derived.by(() => {
    const channels = guildsStore.channelsByGuild[guildId] ?? [];
    const out: { id: string; name: string; userIds: string[] }[] = [];
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

  // Namen für noch nicht gecachte User nachladen (batched + debounced).
  $effect(() => {
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
