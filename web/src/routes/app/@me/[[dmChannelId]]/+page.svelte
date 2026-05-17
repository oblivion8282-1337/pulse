<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import DMChannelList from '$lib/components/DMChannelList.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { chatApi } from '$lib/api/chat';
  import { gateway } from '$lib/ws/connection';
  import { readState } from '$lib/stores/readState.svelte';
  import { toast } from 'svelte-sonner';
  import type { Channel, DMChannel, Message } from '$lib/api/types';

  let dmChannelId = $derived(page.params.dmChannelId ?? '');
  let activeDM = $derived<DMChannel | undefined>(
    dmChannelId ? directMessages.byId[dmChannelId] : undefined
  );

  // ChatView expects a `Channel`-shaped object. Synthesise one from the DM —
  // `guild_id` is empty, but we also pass showMemberList={false} so no
  // member-list lookup happens. The `name` is the other user's display name
  // (cached in userCache; falls back to "…" while loading).
  let synthChannel = $derived<Channel | null>(
    activeDM
      ? {
          id: activeDM.id,
          guild_id: '',
          name: userCache.displayName(activeDM.other_user_id),
          type: 0,
          position: 0,
          topic: null,
          created_at: activeDM.created_at
        }
      : null
  );

  let visibleMessages = $derived(dmChannelId ? messages.for(dmChannelId) : []);

  let sidebarOpen = $state(false);
  let loadError = $state<string | null>(null);
  let resolving = $state(false);

  let prevDM = $state('');
  let switchGen = $state(0);
  const pendingOptimisticTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Mirrors the channel-page effect: when the DM id in the URL changes, load
  // messages + subscribe + leave the previous one. The DM record itself is
  // already in the store (seeded by ready / hydrate / dm_bump).
  $effect(() => {
    const cid = dmChannelId;
    void switchTo(cid);
  });

  // WS reconnect: messages.clearChannel() may empty the loaded set. Re-fetch
  // if we're still parked on this DM.
  $effect(() => {
    const cid = dmChannelId;
    if (!cid || messages.loadedChannels[cid]) return;
    if (prevDM !== cid) return;
    if (!directMessages.byId[cid]) return;
    void chatApi
      .listMessages(cid)
      .then((history) => {
        if (untrack(() => prevDM) === cid) messages.setInitial(cid, history);
      })
      .catch(() => {
        /* user-driven retry via navigation */
      });
  });

  // Prime the user cache for the other user of every DM so the sidebar +
  // header name resolve without a flash of "…".
  $effect(() => {
    for (const dm of directMessages.list) userCache.queue(dm.other_user_id);
  });

  onDestroy(() => {
    for (const handle of pendingOptimisticTimeouts.values()) clearTimeout(handle);
    pendingOptimisticTimeouts.clear();
    if (prevDM) gateway.unsubscribe(prevDM);
  });

  async function switchTo(cid: string) {
    const gen = untrack(() => (switchGen += 1));
    const isStale = () => untrack(() => switchGen) !== gen;
    const prev = untrack(() => prevDM);

    if (cid === prev) return;
    if (prev) gateway.unsubscribe(prev);

    if (!cid) {
      untrack(() => (prevDM = ''));
      return;
    }

    if (!directMessages.byId[cid]) {
      // We don't know this DM yet — pull it (e.g. deep link before hydrate
      // finished, or the recipient opening a freshly-created DM).
      try {
        resolving = true;
        const dm = await chatApi.getDMChannel(cid);
        if (isStale()) return;
        directMessages.upsert(dm);
      } catch (err) {
        if (isStale()) return;
        loadError = err instanceof Error ? err.message : 'DM nicht gefunden';
        resolving = false;
        return;
      }
    }

    try {
      if (!messages.loadedChannels[cid]) {
        const history = await chatApi.listMessages(cid);
        if (isStale()) return;
        messages.setInitial(cid, history);
      }
    } catch (err) {
      if (isStale()) return;
      loadError = err instanceof Error ? err.message : 'Nachrichten konnten nicht geladen werden';
      resolving = false;
      return;
    }

    if (isStale()) return;
    gateway.subscribe(cid);
    const loaded = messages.for(cid);
    const latestSeen = loaded[loaded.length - 1]?.id;
    if (latestSeen) readState.recordSeen(cid, latestSeen);
    // Acknowledge up to whatever we know is the latest — including ids
    // bumped in via dm_bump while we weren't subscribed (those don't land
    // in `messages.byChannel`, so `latestSeen` can lag behind).
    readState.markRead(cid);
    untrack(() => (prevDM = cid));
    loadError = null;
    resolving = false;
  }

  async function selectGuild(g: { id: string }) {
    sidebarOpen = false;
    await goto(`/app/guilds/${g.id}/channels/_`);
  }

  async function selectDM(dm: DMChannel) {
    sidebarOpen = false;
    if (dm.id === dmChannelId) return;
    await goto(`/app/@me/${dm.id}`);
  }

  function sendMessage(text: string, replyToId: string | null, attachmentIds: string[]) {
    if (!activeDM || !auth.user) return;
    const nonce = `n-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const tmpId = `tmp-${nonce}`;
    const cid = activeDM.id;
    messages.addOptimistic({
      id: tmpId,
      channel_id: cid,
      author_id: auth.user.id,
      content: text,
      nonce,
      reply_to_id: replyToId,
      created_at: new Date().toISOString()
    });
    // Attachments go through REST — the WS send-op doesn't carry
    // attachment_ids and presigned URLs need server-side signing anyway.
    // Pure-text messages stay on the WS fast-path.
    if (attachmentIds.length > 0) {
      chatApi.postMessage(cid, text, { nonce, replyToId, attachmentIds })
        .then((real) => messages.upsert(real))
        .catch((e) => {
          messages.removeOptimistic(cid, tmpId);
          toast.error('Senden fehlgeschlagen', { description: (e as Error).message });
        });
      return;
    }
    const queued = gateway.send(cid, text, nonce, replyToId);
    if (!queued) {
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
    } catch (e) {
      toast.error('Bearbeiten fehlgeschlagen');
      console.error(e);
    }
  }

  async function deleteMessage(m: Message) {
    if (!confirm('Nachricht wirklich löschen?')) return;
    try {
      await chatApi.deleteMessage(m.id);
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
    } catch (e) {
      toast.error('Reaktion fehlgeschlagen');
      console.error(e);
    }
  }
</script>

{#if sidebarOpen}
  <div
    class="fixed inset-0 z-30 bg-black/40 md:hidden"
    role="presentation"
    onclick={() => (sidebarOpen = false)}
  ></div>
{/if}

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={auth.user?.id ?? null}
  homeActive={true}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app')}
  onHomeClick={async () => {
    sidebarOpen = false;
    await goto('/app/@me');
  }}
/>

<div
  class="
    fixed inset-y-0 left-16 z-40 w-72 transition-transform duration-300 ease-out
    {sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
    md:relative md:inset-auto md:left-auto md:z-auto md:w-auto md:translate-x-0 md:transition-none
  "
>
  <DMChannelList activeDMId={dmChannelId || null} onSelect={selectDM} />
</div>

{#if loadError}
  <section
    class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 md:rounded-2xl"
  >
    <p class="text-sm text-red-400" data-testid="load-error">{loadError}</p>
  </section>
{:else if activeDM && synthChannel}
  <ChatView
    channel={synthChannel}
    messages={visibleMessages}
    onSend={sendMessage}
    onMenuClick={() => (sidebarOpen = true)}
    headerKind="dm"
    showMemberList={false}
    onEditMessage={editMessage}
    onDeleteMessage={deleteMessage}
    onToggleReaction={toggleReaction}
  />
{:else}
  <section
    class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-none p-8 md:rounded-2xl"
    data-testid="dm-empty-state"
  >
    <p class="text-text-bright text-base font-semibold">Direktnachrichten</p>
    <p class="text-text-muted max-w-sm text-center text-sm">
      Wähle links eine bestehende DM aus oder klick im Channel auf einen Member, um eine neue zu starten.
    </p>
  </section>
{/if}
