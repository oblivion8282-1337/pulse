<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import CreateGuildDialog from '$lib/components/CreateGuildDialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { chatApi } from '$lib/api/chat';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import UserFooter from '$lib/components/UserFooter.svelte';

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

<aside class="glass-panel flex h-full w-full flex-col overflow-hidden rounded-none md:w-56 md:rounded-2xl lg:w-64" data-testid="channel-list-placeholder">
  <div class="flex-1"></div>
  <UserFooter />
</aside>

<div class="glass-panel text-text-muted flex flex-1 items-center justify-center rounded-none text-sm md:rounded-2xl">
  {#if guilds.list.length === 0}
    <div class="text-center">
      <p class="text-text-bright mb-2 text-lg font-semibold">Noch keine Server</p>
      <Button onclick={() => (creating = true)} data-testid="empty-create-guild">Server erstellen</Button>
    </div>
  {:else}
    Wähle einen Server.
  {/if}
</div>

<CreateGuildDialog
  open={creating}
  onClose={() => (creating = false)}
  onCreate={createGuild}
  onJoin={joinGuild}
/>

{#if auth.user}
  <div class="hidden" data-testid="current-user-id">{auth.user.id}</div>
{/if}
