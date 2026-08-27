<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import CreateGuildDialog from '$lib/components/CreateGuildDialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { auth } from '$lib/stores/auth.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { darfCommunityAnlegen } from '$lib/servers/erstellrecht';
  import { serverAdmin } from '$lib/stores/serverAdmin.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { guildSounds } from '$lib/stores/guildSounds.svelte';
  import { chatApi } from '$lib/api/chat';
  import { rolesApi } from '$lib/api/roles';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { voiceAutoConnect } from '$lib/voice/autoconnect.svelte';
  import DMChannelList from '$lib/components/DMChannelList.svelte';
  import type { DMChannel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  // Darf ich auf dem AKTIVEN Server eine Community anlegen? Rechnung in
  // ``lib/servers/erstellrecht.ts`` (eine Stelle für alle drei Aufrufer).
  const canCreateGuild = $derived(
    darfCommunityAnlegen({
      istCloud: activeServer.current?.isCloud ?? false,
      cloudAdmin: !!auth.user?.is_admin,
      rolleLautCloud: activeServer.current?.role ?? null,
      adminLautServer: serverAdmin.has(activeServer.serverId)
        ? serverAdmin.isAdmin(activeServer.serverId)
        : null,
      offenFuerAlle: capabilities.allowGuildCreation,
    }),
  );

  let creating = $state(false);
  // Which screen the add-community dialog opens on. The rail's "+" menu sets
  // 'create' / 'join' to land on a specific form; the empty-state button uses
  // 'choose' to show the picker.
  let createMode = $state<'choose' | 'create' | 'join'>('choose');

  onMount(() => {
    // Opened from the @me-rail's "+" menu with ?add=create|join → land
    // straight on the add-community dialog (in that mode) instead of
    // auto-redirecting into the first community.
    const add = page.url.searchParams.get('add');
    if (add === 'create' || add === 'join') {
      createMode = add;
      creating = true;
      return;
    }
    // Auto-Connect-Ziel gewinnt gegen den Default-Landing (Freunde-Seite):
    // der User will seinen gewählten Voice-Channel sofort sehen. Der
    // eigentliche Voice-Join läuft unabhängig davon im Layout
    // (autoConnectIfConfigured) — hier geht es nur um die Ansicht.
    const auto = voiceAutoConnect.validTarget();
    if (auto?.guildId && guilds.list.some((g) => g.id === auto.guildId)) {
      navDrawer.open = true;
      void goto(`/app/guilds/${auto.guildId}/channels/${auto.channelId}`, { replaceState: true });
      return;
    }
    void goto('/app/friends', { replaceState: true });
  });

  async function createGuild(name: string) {
    const g = await chatApi.createGuild(name);
    guilds.add(g);
    // Seed empty stores for the new guild so per-guild affordances render
    // immediately as "no overrides yet" / owner-grants-all instead of
    // staying hidden until the next WS reconnect rebuilds ``ready``.
    roles.recomputeGuild(g.id);
    guildSounds.ensureSlot(g.id);
    void rolesApi
      .list(g.id)
      .then((rows) => {
        for (const r of rows) roles.upsertRole(r);
      })
      .catch(() => undefined);
    creating = false;
    const c = await chatApi.createChannel(g.id, { name: 'general' });
    guilds.addChannel(c);
    await goto(`/app/guilds/${g.id}/channels/${c.id}`);
  }

  async function joinGuild(linkOrCode: string, confirmed?: boolean) {
    await joinGuildByInvite(linkOrCode, confirmed ?? false);
    creating = false;
  }
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={null}
  currentUserId={currentServerUserId()}
  homeActive={true}
  onSelect={(g) => {
    // Wie auf den anderen Seiten: Community-Tap öffnet zuerst die Kanal-Liste
    // (mobiler Drawer), nicht direkt den Chat des ersten Textkanals.
    navDrawer.open = true;
    goto(`/app/guilds/${g.id}/channels/_`);
  }}
  onCreateClick={() => { createMode = 'create'; creating = true; }}
  onJoinClick={() => { createMode = 'join'; creating = true; }}
  onHomeClick={() => goto('/app/friends')}
/>

<!-- DM-/Freunde-Liste auch ohne Community: ein community-loser User muss seine
     Direktnachrichten + Freundschaftsanfragen erreichen können. Ohne diese
     Liste war /app eine Sackgasse und das Pulse-Icon ein toter Link. -->
<DMChannelList
  activeDMId={null}
  onSelect={(dm: DMChannel) => goto(`/app/@me/${dm.id}`)}
/>

<div class="glass-panel text-text-muted flex flex-1 items-center justify-center rounded-none text-sm md:rounded-2xl">
  {#if guilds.list.length === 0}
    <div class="text-center">
      <p class="text-text-bright mb-2 text-lg font-semibold">{m.app_no_communities()}</p>
      <Button onclick={() => { createMode = 'choose'; creating = true; }} data-testid="empty-create-guild">
        {canCreateGuild ? m.app_create_or_join_community() : m.app_join_community()}
      </Button>
      {#if !canCreateGuild}
        <p class="text-text-muted mt-2 text-xs">
          {m.app_creation_disabled_hint()}
        </p>
      {/if}
    </div>
  {:else}
    {m.app_select_community()}
  {/if}
</div>

<CreateGuildDialog
  open={creating}
  canCreate={canCreateGuild}
  initialMode={createMode}
  onClose={() => (creating = false)}
  onCreate={createGuild}
  onJoin={joinGuild}
/>

{#if auth.user}
  <div class="hidden" data-testid="current-user-id">{auth.user.id}</div>
{/if}
