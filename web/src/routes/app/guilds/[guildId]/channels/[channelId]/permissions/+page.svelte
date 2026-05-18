<!--
  Channel-permissions editor route. Separate page rather than a modal
  because there's no channel-settings dialog yet in the codebase; the
  ChannelList context-menu navigates here.

  MANAGE_PERMISSIONS gates the entire surface (server enforces it
  independently). The page also lazy-loads the channel's overwrites if
  they aren't already cached.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { rolesApi } from '$lib/api/roles';
  import { Perm } from '$lib/permissions/bitfield';
  import ChannelOverridesEditor from '$lib/components/settings/ChannelOverridesEditor.svelte';

  let guildId = $derived(page.params.guildId ?? '');
  let channelId = $derived(page.params.channelId ?? '');
  let guild = $derived(guilds.byId[guildId]);
  let channel = $derived(
    (guilds.channelsByGuild[guildId] ?? []).find((c) => c.id === channelId)
  );
  let editorPermissions = $derived(roles.myGuildPerms[guildId] ?? '0');
  // We use guild-wide MANAGE_PERMISSIONS as the entry gate. The override
  // editor itself does per-bit checks via the editorPermissions prop.
  let canEdit = $derived(roles.hasGuildPermission(guildId, Perm.MANAGE_PERMISSIONS));

  onMount(() => {
    if (channelId) void channelPermissions.ensure(channelId).catch(() => undefined);
    if (guildId && !roles.byGuild[guildId]?.length) {
      void rolesApi
        .list(guildId)
        .then((rows) => {
          for (const r of rows) roles.upsertRole(r);
        })
        .catch(() => undefined);
    }
  });
</script>

<svelte:head>
  <title>Kanal-Berechtigungen — Pulse</title>
</svelte:head>

<div class="bg-bg-base text-text-base min-h-screen">
  <header class="border-border bg-bg-base/95 sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-3 backdrop-blur">
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={() => goto(`/app/guilds/${guildId}/channels/${channelId}`)}
    >
      <ArrowLeftIcon />
    </Button>
    <h1 class="text-text-bright text-base font-semibold">
      #{channel?.name ?? '…'} · Berechtigungen
    </h1>
  </header>

  <main class="mx-auto max-w-3xl px-4 py-6">
    {#if !guild || !channel}
      <p class="text-text-muted text-sm">Kanal nicht gefunden.</p>
    {:else if !canEdit}
      <p class="text-text-muted text-sm">
        Du brauchst „Berechtigungen verwalten" (MANAGE_PERMISSIONS) für diesen Server.
      </p>
    {:else}
      <ChannelOverridesEditor {channelId} {guildId} {editorPermissions} />
    {/if}
  </main>
</div>
