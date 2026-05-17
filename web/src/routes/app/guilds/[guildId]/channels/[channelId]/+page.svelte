<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ChannelList from '$lib/components/ChannelList.svelte';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import VoiceChannelView from '$lib/components/VoiceChannelView.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import CreateGuildDialog from '$lib/components/CreateGuildDialog.svelte';
  import CreateChannelDialog from '$lib/components/CreateChannelDialog.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { chatApi } from '$lib/api/chat';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { gateway } from '$lib/ws/connection';
  import { voice } from '$lib/voice/livekit.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { toast } from 'svelte-sonner';
  import type { Channel, Message } from '$lib/api/types';

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
  let sidebarOpen = $state(false);

  let prevGuild = $state('');
  let prevChannel = $state('');
  // $state so the writes below don't re-trigger the effect (they're wrapped in
  // untrack regardless, but a plain `let` would also break gen-comparison in
  // a reactive context).
  let switchGen = $state(0);
  // Tracks pending optimistic-message timeout handles; cancelled on nav/destroy.
  const pendingOptimisticTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  $effect(() => {
    const g = guildId;
    const c = channelId;
    void switchTo(g, c);
  });

  // WS reconnect path: connection.ts calls messages.clearChannel(cid) for every
  // subscribed channel on `open`, which empties byChannel + loadedChannels.
  // switchTo only fires on URL change — so without this effect the user would
  // see an empty chat until they navigate away. We watch for the load flag
  // disappearing *after* we already switched to the channel and re-fetch.
  $effect(() => {
    const cid = channelId;
    if (!cid || messages.loadedChannels[cid]) return;
    if (prevChannel !== cid) return; // initial switchTo path handles its own fetch
    const ch = guilds.channelsByGuild[guildId]?.find((c) => c.id === cid);
    if (!ch || ch.type !== 0) return;
    void chatApi
      .listMessages(cid)
      .then((history) => {
        if (untrack(() => prevChannel) === cid) messages.setInitial(cid, history);
      })
      .catch(() => {
        // Best-effort: the user can navigate to retry.
      });
  });

  onMount(() => {
    const offChan = gateway.onChannelDeleted(handleRemoteChannelDeleted);
    const offGuild = gateway.onGuildDeleted(handleRemoteGuildDeleted);

    // Escape schließt Drawer auf Mobil
    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape' && sidebarOpen) sidebarOpen = false;
    }
    window.addEventListener('keydown', onKeydown);

    return () => {
      offChan();
      offGuild();
      window.removeEventListener('keydown', onKeydown);
    };
  });

  onDestroy(() => {
    for (const handle of pendingOptimisticTimeouts.values()) clearTimeout(handle);
    pendingOptimisticTimeouts.clear();
  });

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
        // Acknowledge unread state: the user is now looking at this channel.
        // markRead uses latestByChannel — which also reflects ids learned via
        // channel_bump while we weren't subscribed. loaded[…].id alone would
        // lag behind those.
        const loaded = messages.for(target);
        const latestSeen = loaded[loaded.length - 1]?.id;
        if (latestSeen) readState.recordSeen(target, latestSeen);
        readState.markRead(target);
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

  async function handleRemoteGuildDeleted(gId: string) {
    if (gId !== guildId) return;
    // Store was already pruned in connection.ts. If we were in a voice
    // channel in this guild, disconnect — channels are gone.
    if (voice.connected || voice.connecting) await voice.disconnect().catch(() => undefined);
    await navigateAfterGuildGone();
  }

  async function navigateAfterGuildGone() {
    const remaining = guilds.list;
    if (remaining.length > 0) {
      await goto(`/app/guilds/${remaining[0].id}/channels/_`, { replaceState: true });
    } else {
      await goto('/app', { replaceState: true });
    }
  }

  async function selectGuild(id: string) {
    sidebarOpen = false;
    if (id === guildId) return;
    await goto(`/app/guilds/${id}/channels/_`);
  }

  async function selectChannel(c: Channel) {
    sidebarOpen = false;
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

  async function joinGuild(linkOrCode: string) {
    await joinGuildByInvite(linkOrCode);
    creatingGuild = false;
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

  function sendMessage(text: string, replyToId: string | null) {
    if (!activeChannel || activeChannel.type !== 0 || !auth.user) return;
    const nonce = `n-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const tmpId = `tmp-${nonce}`;
    const cid = activeChannel.id;
    messages.addOptimistic({
      id: tmpId,
      channel_id: cid,
      author_id: auth.user.id,
      content: text,
      nonce,
      reply_to_id: replyToId,
      created_at: new Date().toISOString()
    });
    const queued = gateway.send(cid, text, nonce, replyToId);
    if (!queued) {
      // WS not open — roll back the optimistic message and inform the user.
      messages.removeOptimistic(cid, tmpId);
      toast.error('Keine Verbindung — bitte erneut senden');
      return;
    }
    const handle = setTimeout(() => {
      pendingOptimisticTimeouts.delete(nonce);
      if (!messages.isConfirmed(nonce)) {
        messages.removeOptimistic(cid, tmpId);
        toast.error('Nachricht konnte nicht gesendet werden');
      }
    }, 10_000);
    pendingOptimisticTimeouts.set(nonce, handle);
  }

  async function editMessage(m: Message, content: string) {
    try {
      await chatApi.editMessage(m.id, content);
      // WS broadcasts `message_update` to update local store.
    } catch (e) {
      toast.error('Bearbeiten fehlgeschlagen');
      console.error(e);
    }
  }

  async function deleteMessage(m: Message) {
    if (!confirm('Nachricht wirklich löschen?')) return;
    try {
      await chatApi.deleteMessage(m.id);
      // WS broadcasts `message_delete`.
    } catch (e) {
      toast.error('Löschen fehlgeschlagen');
      console.error(e);
    }
  }

  async function toggleReaction(m: Message, emoji: string, currentlyMine: boolean) {
    try {
      if (currentlyMine) {
        await chatApi.removeReaction(m.id, emoji);
      } else {
        await chatApi.addReaction(m.id, emoji);
      }
      // WS broadcasts reaction_add/reaction_remove.
    } catch (e) {
      toast.error('Reaktion fehlgeschlagen');
      console.error(e);
    }
  }
</script>

<!-- Mobile Drawer Backdrop -->
{#if sidebarOpen}
  <div
    class="fixed inset-0 z-30 bg-black/40 md:hidden"
    role="presentation"
    onclick={() => (sidebarOpen = false)}
  ></div>
{/if}

<!-- Guild-Rail: immer sichtbar (auch Mobil), Discord-Style. -->
<GuildRail
  guilds={guilds.list}
  activeGuildId={guildId}
  currentUserId={auth.user?.id ?? null}
  onSelect={(g) => selectGuild(g.id)}
  onCreateClick={() => (creatingGuild = true)}
  onHomeClick={() => { sidebarOpen = false; void goto('/app/@me'); }}
  onGuildDeleted={(gId) => { if (gId === guildId) void handleRemoteGuildDeleted(gId); }}
/>

<!-- Channel-Sidebar: inline auf md+, Drawer auf Mobil -->
<div
  class="
    fixed inset-y-0 left-16 z-40 w-72 transition-transform duration-300 ease-out
    {sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
    md:relative md:inset-auto md:left-auto md:z-auto md:w-auto md:translate-x-0 md:transition-none
  "
>
  <ChannelList
    guild={activeGuild ?? null}
    channels={channelsForGuild}
    activeChannelId={activeChannel?.id ?? null}
    onSelect={selectChannel}
    onCreateClick={() => (creatingChannel = true)}
    {onChannelDeleted}
    canCreate={!!activeGuild && auth.user?.id === activeGuild.owner_id}
  />
</div>

{#if isVoiceChannel && activeChannel}
  {#key activeChannel.id}
    <VoiceChannelView channel={activeChannel} onMenuClick={() => (sidebarOpen = true)} />
  {/key}
{:else if loadError}
  <section class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 md:rounded-2xl">
    <p class="text-sm text-red-400" data-testid="load-error">{loadError}</p>
    <Button
      onclick={() => { loadError = null; prevGuild = ''; prevChannel = ''; void switchTo(guildId, channelId); }}
      data-testid="load-retry"
    >Erneut versuchen</Button>
  </section>
{:else}
  <ChatView
    channel={activeChannel}
    messages={visibleMessages}
    onSend={sendMessage}
    onMenuClick={() => (sidebarOpen = true)}
    isOwner={!!activeGuild && auth.user?.id === activeGuild.owner_id}
    onEditMessage={editMessage}
    onDeleteMessage={deleteMessage}
    onToggleReaction={toggleReaction}
  />
{/if}

<CreateGuildDialog
  open={creatingGuild}
  onClose={() => (creatingGuild = false)}
  onCreate={createGuild}
  onJoin={joinGuild}
/>

<CreateChannelDialog open={creatingChannel} onClose={() => (creatingChannel = false)} onCreate={createChannel} />
