<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import GuildList from '$lib/components/GuildList.svelte';
  import ChannelList from '$lib/components/ChannelList.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import VoiceChannelView from '$lib/components/VoiceChannelView.svelte';
  import CreateGuildDialog from '$lib/components/CreateGuildDialog.svelte';
  import CreateChannelDialog from '$lib/components/CreateChannelDialog.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { chatApi } from '$lib/api/chat';
  import { gateway } from '$lib/ws/connection';
  import { toast } from 'svelte-sonner';
  import type { Channel } from '$lib/api/types';

  let guildId = $derived(page.params.guildId ?? '');
  let channelId = $derived(page.params.channelId ?? '');
  let activeGuild = $derived<typeof guilds.byId[string] | undefined>(guilds.byId[guildId]);
  let channelsForGuild = $derived<Channel[]>(guilds.channelsByGuild[guildId] ?? []);
  let activeChannel = $derived<Channel | null>(
    channelsForGuild.find((c: Channel) => c.id === channelId) ?? null
  );
  let isVoiceChannel = $derived(activeChannel?.type === 1);
  let visibleMessages = $derived(messages.for(channelId));

  let creatingGuild = $state(false);
  let creatingChannel = $state(false);
  let resolving = $state(true);
  let loadError = $state<string | null>(null);

  let prevGuild = $state('');
  let prevChannel = $state('');
  // $state so the writes below don't re-trigger the effect (they're wrapped in
  // untrack regardless, but a plain `let` would also break gen-comparison in
  // a reactive context).
  let switchGen = $state(0);

  $effect(() => {
    const g = guildId;
    const c = channelId;
    void switchTo(g, c);
  });

  onMount(() => gateway.onChannelDeleted(handleRemoteChannelDeleted));

  async function switchTo(g: string, c: string) {
    if (!g) return;
    // All access to switchGen/prevGuild/prevChannel goes through untrack so the
    // surrounding $effect never re-triggers on our own writes.
    const isStale = () => untrack(() => switchGen) !== gen;
    const gen = untrack(() => (switchGen += 1));
    const prevG = untrack(() => prevGuild);
    const prevC = untrack(() => prevChannel);

    if (g !== prevG) {
      resolving = true;
      loadError = null;
      try {
        await guilds.loadChannels(g);
      } catch (err) {
        if (isStale()) return;
        loadError = err instanceof Error ? err.message : 'Kanäle konnten nicht geladen werden';
        resolving = false;
        return;
      }
      if (isStale()) return;
      untrack(() => (prevGuild = g));
    }
    const list = guilds.channelsByGuild[g] ?? [];
    let target: string | null = c;
    if (c === '_' || !list.find((ch) => ch.id === c)) {
      const first = list.find((ch) => ch.type === 0) ?? list[0];
      if (first) {
        await goto(`/app/guilds/${g}/channels/${first.id}`, { replaceState: true, noScroll: true });
        return;
      }
      target = null;
    }

    if (target && target !== prevC) {
      // Leave the previous text channel's WS subscription.
      if (prevC) gateway.unsubscribe(prevC);
      const ch = list.find((x) => x.id === target);
      // Only text channels have message history + WS subscriptions.
      // Voice channels are handled entirely by VoiceChannelView/LiveKit.
      if (ch && ch.type === 0) {
        try {
          if (!messages.loadedChannels[target]) {
            const history = await chatApi.listMessages(target);
            if (isStale()) return;
            messages.setInitial(target, history);
          }
        } catch (err) {
          if (isStale()) return;
          loadError = err instanceof Error ? err.message : 'Nachrichten konnten nicht geladen werden';
          resolving = false;
          return;
        }
        // Only subscribe once this switch is still the active one — otherwise
        // a faster switch already moved on and we'd leak a subscription.
        if (isStale()) return;
        gateway.subscribe(target);
      }
      // Record prevChannel only after the whole operation succeeded.
      untrack(() => (prevChannel = target!));
    }
    if (isStale()) return;
    loadError = null;
    resolving = false;
  }

  function handleRemoteChannelDeleted(gId: string, cId: string) {
    if (gId === guildId && cId === channelId) {
      // The connection.ts handler already pruned the store + subscription; we
      // just navigate away from the now-gone channel.
      void onChannelDeleted(cId);
    }
  }

  async function selectGuild(id: string) {
    if (id === guildId) return;
    await goto(`/app/guilds/${id}/channels/_`);
  }

  async function selectChannel(c: Channel) {
    if (c.id === channelId) return;
    await goto(`/app/guilds/${guildId}/channels/${c.id}`);
  }

  async function createGuild(name: string) {
    const g = await chatApi.createGuild(name);
    guilds.add(g);
    creatingGuild = false;
    const ch = await chatApi.createChannel(g.id, { name: 'general' });
    guilds.addChannel(ch);
    await goto(`/app/guilds/${g.id}/channels/${ch.id}`);
  }

  async function createChannel(name: string, type: number) {
    if (!activeGuild) return;
    const ch = await chatApi.createChannel(activeGuild.id, { name, type });
    guilds.addChannel(ch);
    creatingChannel = false;
    await goto(`/app/guilds/${activeGuild.id}/channels/${ch.id}`);
  }

  async function onChannelDeleted(deletedId: string) {
    if (deletedId === channelId) {
      // Navigate away from the deleted channel.
      const remaining = (guilds.channelsByGuild[guildId] ?? []).filter((c) => c.id !== deletedId);
      const next = remaining.find((c) => c.type === 0) ?? remaining[0];
      if (next) {
        await goto(`/app/guilds/${guildId}/channels/${next.id}`, { replaceState: true });
      } else {
        await goto(`/app/guilds/${guildId}/channels/_`, { replaceState: true });
      }
    }
  }

  function sendMessage(text: string) {
    if (!activeChannel || activeChannel.type !== 0 || !auth.user) return;
    const nonce = `n-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const tmpId = `tmp-${nonce}`;
    messages.addOptimistic({
      id: tmpId,
      channel_id: activeChannel.id,
      author_id: auth.user.id,
      content: text,
      nonce,
      created_at: new Date().toISOString()
    });
    const queued = gateway.send(activeChannel.id, text, nonce);
    if (!queued) {
      // WS not open — roll back the optimistic message and inform the user.
      messages.removeOptimistic(activeChannel.id, tmpId);
      toast.error('Keine Verbindung — bitte erneut senden');
    }
  }
</script>

<GuildList
  guilds={guilds.list}
  activeGuildId={guildId}
  onSelect={(g) => selectGuild(g.id)}
  onCreateClick={() => (creatingGuild = true)}
/>

<ChannelList
  guild={activeGuild ?? null}
  channels={channelsForGuild}
  activeChannelId={activeChannel?.id ?? null}
  onSelect={selectChannel}
  onCreateClick={() => (creatingChannel = true)}
  {onChannelDeleted}
  canCreate={!!activeGuild && auth.user?.id === activeGuild.owner_id}
/>

{#if isVoiceChannel && activeChannel}
  {#key activeChannel.id}
    <VoiceChannelView channel={activeChannel} />
  {/key}
{:else if loadError}
  <section class="bg-bg-chat flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8">
    <p class="text-sm text-red-400" data-testid="load-error">{loadError}</p>
    <button
      class="rounded bg-neutral-700 px-4 py-2 text-sm text-white hover:bg-neutral-600"
      onclick={() => { loadError = null; prevGuild = ''; prevChannel = ''; void switchTo(guildId, channelId); }}
      data-testid="load-retry"
    >Erneut versuchen</button>
  </section>
{:else}
  <ChatView channel={activeChannel} messages={visibleMessages} onSend={sendMessage} />
{/if}

<CreateGuildDialog open={creatingGuild} onClose={() => (creatingGuild = false)} onCreate={createGuild} />

<CreateChannelDialog open={creatingChannel} onClose={() => (creatingChannel = false)} onCreate={createChannel} />
