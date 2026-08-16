<!--
  Kanalrechte-Seite. Eigene Route statt Dialog, weil es (noch) keinen
  Kanal-Einstellungsdialog gibt; das Kontextmenü der Kanalliste führt hierher.

  Zwei Reiter: „Rechte" stellt ein, „Prüfen" beantwortet die Frage, die man
  wirklich hat („darf anna hier streamen?"). MANAGE_PERMISSIONS gilt für beide
  (der Server prüft es unabhängig); der Editor prüft zusätzlich Bit für Bit
  über `editorPermissions`.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { serverGuilds } from '$lib/stores/serverGuilds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { rolesApi } from '$lib/api/roles';
  import { Perm } from '$lib/permissions/bitfield';
  import ChannelOverridesEditor from '$lib/components/settings/ChannelOverridesEditor.svelte';
  import PruefenAnsicht from '$lib/permissions/ui/PruefenAnsicht.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let guildId = $derived(page.params.guildId ?? '');
  let channelId = $derived(page.params.channelId ?? '');
  // Fallback auf den multi-server ``serverGuilds``-Cache, falls der WS noch
  // auf einem anderen Server hängt (``guilds.byId`` ist single-server-scoped).
  let guild = $derived(guilds.byId[guildId] ?? serverGuilds.findGuild(guildId));
  let channel = $derived(
    (guilds.channelsByGuild[guildId] ?? []).find((c) => c.id === channelId)
  );
  let editorPermissions = $derived(roles.myGuildPerms[guildId] ?? '0');
  // We use guild-wide MANAGE_PERMISSIONS as the entry gate. The override
  // editor itself does per-bit checks via the editorPermissions prop.
  let canEdit = $derived(roles.hasGuildPermission(guildId, Perm.MANAGE_PERMISSIONS));

  let reiter = $state<'rechte' | 'pruefen'>('rechte');
  // Abgeleitet statt konstant: die Beschriftungen kommen aus Paraglide und
  // würden als Konstante die Sprache beim Laden des Moduls einfrieren.
  let reiterliste = $derived([
    { id: 'rechte' as const, text: m.kanalrechte_tab_rechte() },
    { id: 'pruefen' as const, text: m.kanalrechte_tab_pruefen() }
  ]);

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
  <title>{m.channel_permissions_page_title()}</title>
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
      {m.channel_permissions_heading({ name: channel?.name ?? '…' })}
    </h1>
  </header>

  <main class="mx-auto max-w-5xl px-4 py-6">
    {#if !guild || !channel}
      <p class="text-text-muted text-sm">{m.channel_permissions_channel_not_found()}</p>
    {:else if !canEdit}
      <p class="text-text-muted text-sm">
        {m.channel_permissions_no_permission()}
      </p>
    {:else}
      <div class="border-border bg-bg-input/40 mb-4 inline-flex rounded-lg border p-0.5">
        {#each reiterliste as tab (tab.id)}
          <button
            type="button"
            class="rounded-md px-3 py-1 text-sm transition-colors"
            class:bg-bg-hover={reiter === tab.id}
            class:text-text-bright={reiter === tab.id}
            class:text-text-muted={reiter !== tab.id}
            onclick={() => (reiter = tab.id)}
            aria-pressed={reiter === tab.id}
            data-testid={`perm-tab-${tab.id}`}
          >{tab.text}</button>
        {/each}
      </div>

      {#if reiter === 'rechte'}
        <ChannelOverridesEditor
          {channelId}
          {guildId}
          kanalName={channel.name}
          {editorPermissions}
        />
      {:else}
        <PruefenAnsicht {guildId} {channelId} kanalName={channel.name} />
      {/if}
    {/if}
  </main>
</div>
