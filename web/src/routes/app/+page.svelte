<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import GuildList from '$lib/components/GuildList.svelte';
  import CreateGuildDialog from '$lib/components/CreateGuildDialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { chatApi } from '$lib/api/chat';

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
</script>

<GuildList
  guilds={guilds.list}
  activeGuildId={null}
  onSelect={(g) => goto(`/app/guilds/${g.id}/channels/_`)}
  onCreateClick={() => (creating = true)}
/>

<div class="text-text-muted flex flex-1 items-center justify-center text-sm">
  {#if guilds.list.length === 0}
    <div class="text-center">
      <p class="text-text-bright mb-2 text-lg">Noch keine Server</p>
      <Button onclick={() => (creating = true)} data-testid="empty-create-guild">Server erstellen</Button>
    </div>
  {:else}
    Wähle einen Server.
  {/if}
</div>

<CreateGuildDialog open={creating} onClose={() => (creating = false)} onCreate={createGuild} />

{#if auth.user}
  <div class="hidden" data-testid="current-user-id">{auth.user.id}</div>
{/if}
