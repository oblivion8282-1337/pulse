<script lang="ts">
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

  let prevGuild = $state('');
  let prevChannel = $state('');

  $effect(() => {
    const g = guildId;
    const c = channelId;
    void switchTo(g, c);
  });

  async function switchTo(g: string, c: string) {
    if (!g) return;
    if (g !== prevGuild) {
      resolving = true;
      try {
        await guilds.loadChannels(g);
      } catch (err) {
        console.error('loadChannels', err);
      }
      prevGuild = g;
    }
    const list = guilds.channelsByGuild[g] ?? [];
    let target: string | null = c;
    if (c === '_' || !list.find((ch) => ch.id === c)) {
      const first = list.find((ch) => ch.type === 0) ?? list[0];
      if (first) {
        target = first.id;
        await goto(`/app/guilds/${g}/channels/${first.id}`, { replaceState: true, noScroll: true });
        return;
      }
      target = null;
    }

    if (target && target !== prevChannel) {
      // Leave the previous text channel's WS subscription.
      if (prevChannel) gateway.unsubscribe(prevChannel);
      const ch = list.find((x) => x.id === target);
      // Only text channels have message history + WS subscriptions.
      // Voice channels are handled entirely by VoiceChannelView/LiveKit.
      if (ch && ch.type === 0) {
        try {
          if (!messages.loadedChannels[target]) {
            const history = await chatApi.listMessages(target);
            messages.setInitial(target, history);
          }
          gateway.subscribe(target);
        } catch (err) {
          console.error('load channel', err);
        }
      }
      prevChannel = target;
    }
    resolving = false;
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

  function sendMessage(text: string) {
    if (!activeChannel || activeChannel.type !== 0 || !auth.user) return;
    const nonce = `n-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    messages.addOptimistic({
      id: `tmp-${nonce}`,
      channel_id: activeChannel.id,
      author_id: auth.user.id,
      content: text,
      nonce,
      created_at: new Date().toISOString()
    });
    gateway.send(activeChannel.id, text, nonce);
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
  canCreate={!!activeGuild && auth.user?.id === activeGuild.owner_id}
/>

{#if isVoiceChannel && activeChannel}
  {#key activeChannel.id}
    <VoiceChannelView channel={activeChannel} />
  {/key}
{:else}
  <ChatView channel={activeChannel} messages={visibleMessages} onSend={sendMessage} />
{/if}

<CreateGuildDialog open={creatingGuild} onClose={() => (creatingGuild = false)} onCreate={createGuild} />

<CreateChannelDialog open={creatingChannel} onClose={() => (creatingChannel = false)} onCreate={createChannel} />
