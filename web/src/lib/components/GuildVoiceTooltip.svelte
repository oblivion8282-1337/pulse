<!--
  GuildVoiceTooltip — Inhalt des Server-Icon-Tooltips in der GuildRail.

  Zeigt den Servernamen und — falls jemand in einem Voice-Channel des
  Servers sitzt — eine kompakte Liste dieser User (Discord-artig). Die
  Voice-Presence kommt rail-weit aus dem `ready`-Frame + `voice_state`-WS-
  Events, ist also auch für gerade nicht geöffnete Server live.

  Nur als Tooltip-Kind verwendet → mountet lazy beim Hovern; die User-Namen
  werden erst dann nachgeladen (userCache batcht/debounct das).
-->
<script lang="ts">
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import { guilds as guildsStore } from '$lib/stores/guilds.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { userCache } from '$lib/stores/users.svelte';

  let { guildId, name }: { guildId: string; name: string } = $props();

  // Alle User-IDs, die in irgendeinem Voice-Channel dieses Servers sitzen,
  // über die Channels hinweg dedupliziert. Voice-Channel = `type === 1`.
  let userIds = $derived.by(() => {
    const channels = guildsStore.channelsByGuild[guildId] ?? [];
    const seen = new Set<string>();
    for (const c of channels) {
      if (c.type !== 1) continue;
      for (const uid of voicePresence.usersIn(c.id)) seen.add(uid);
    }
    return [...seen];
  });

  // Namen für noch nicht gecachte User nachladen (batched + debounced).
  $effect(() => {
    for (const id of userIds) userCache.queue(id);
  });
</script>

<span class="font-medium">{name}</span>
{#if userIds.length > 0}
  <div
    class="flex flex-col items-start gap-0.5"
    data-testid={`guild-voice-${guildId}`}
  >
    <span class="flex items-center gap-1 text-text-muted">
      <Volume2Icon class="size-3" />
      Im Voice — {userIds.length}
    </span>
    <ul class="flex flex-col items-start gap-0.5 pl-4">
      {#each userIds as id (id)}
        <li class="text-text-muted">{userCache.displayName(id)}</li>
      {/each}
    </ul>
  </div>
{/if}
