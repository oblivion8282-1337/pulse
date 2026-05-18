<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import CreateGuildDialog from '$lib/components/CreateGuildDialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { chatApi } from '$lib/api/chat';
  import { rolesApi } from '$lib/api/roles';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import SidebarFooter from '$lib/components/SidebarFooter.svelte';

  // Admins can always create; otherwise gate on the server-wide flag.
  const canCreateGuild = $derived(
    !!auth.user?.is_admin || capabilities.allowGuildCreation
  );

  let creating = $state(false);

  onMount(() => {
    const first = guilds.list[0];
    if (first) {
      void (async () => {
        const channels = await guilds.loadChannels(first.id);
        const text = channels.find((c) => c.type === 0);
        if (text) {
          await goto(`/app/guilds/${first.id}/channels/${text.id}`, { replaceState: true });
        }
      })();
    }
  });

  async function createGuild(name: string) {
    const g = await chatApi.createGuild(name);
    guilds.add(g);
    // Seed the role-store for the new guild so UI gates see the owner
    // as having every permission (Owner short-circuits to GRANT_ALL_SAFE
    // in ``recomputeGuild``). Without this every owner-gated affordance
    // — invite button, channel create, settings — stays hidden until
    // the next WS reconnect rebuilds ``ready``.
    roles.recomputeGuild(g.id);
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

  async function joinGuild(linkOrCode: string) {
    await joinGuildByInvite(linkOrCode);
    creating = false;
  }
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={null}
  currentUserId={auth.user?.id ?? null}
  onSelect={(g) => goto(`/app/guilds/${g.id}/channels/_`)}
  onCreateClick={() => (creating = true)}
/>

<aside class="glass-panel flex h-full w-full flex-col overflow-hidden rounded-none md:w-60 md:rounded-2xl lg:w-68" data-testid="channel-list-placeholder">
  <div class="flex-1"></div>
  <SidebarFooter />
</aside>

<div class="glass-panel text-text-muted flex flex-1 items-center justify-center rounded-none text-sm md:rounded-2xl">
  {#if guilds.list.length === 0}
    <div class="text-center">
      <p class="text-text-bright mb-2 text-lg font-semibold">Noch keine Server</p>
      <Button onclick={() => (creating = true)} data-testid="empty-create-guild">
        {canCreateGuild ? 'Server erstellen oder beitreten' : 'Server beitreten'}
      </Button>
      {#if !canCreateGuild}
        <p class="text-text-muted mt-2 text-xs">
          Server-Erstellung ist vom Admin deaktiviert — du kannst aber per Einladung beitreten.
        </p>
      {/if}
    </div>
  {:else}
    Wähle einen Server.
  {/if}
</div>

<CreateGuildDialog
  open={creating}
  canCreate={canCreateGuild}
  onClose={() => (creating = false)}
  onCreate={createGuild}
  onJoin={joinGuild}
/>

{#if auth.user}
  <div class="hidden" data-testid="current-user-id">{auth.user.id}</div>
{/if}
