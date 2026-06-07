<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import DMChannelList from '$lib/components/DMChannelList.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { directMessages } from '$lib/stores/directMessages.svelte';
  import { userCache } from '$lib/stores/users.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { chatApi } from '$lib/api/chat';
  import { gateway } from '$lib/ws/connection';
  import { readState } from '$lib/stores/readState.svelte';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { parseMentionMarkers } from '$lib/components/messageRender';
  import { toast } from 'svelte-sonner';
  import type { Channel, DMChannel, Message } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

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
        loadError = err instanceof Error ? err.message : m.dm_page_dm_not_found();
        resolving = false;
        return;
      }
    }

    // Cached from an earlier visit? Then its WS subscription lapsed while we
    // were away — re-subscribe + gap-fill below instead of re-fetching.
    const alreadyLoaded = !!messages.loadedChannels[cid];
    try {
      if (!alreadyLoaded) {
        const history = await chatApi.listMessages(cid);
        if (isStale()) return;
        messages.setInitial(cid, history);
      }
    } catch (err) {
      if (isStale()) return;
      loadError = err instanceof Error ? err.message : m.dm_page_messages_load_failed();
      resolving = false;
      return;
    }

    if (isStale()) return;
    gateway.subscribe(cid);
    // Backfill anything that landed while the subscription was dropped.
    if (alreadyLoaded) void gateway.gapFill(cid);
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
    // Server-Icon ist der Drawer-Trigger — dort dann den Channel-Drawer auf.
    navDrawer.open = true;
    await goto(`/app/guilds/${g.id}/channels/_`);
  }

  async function selectDM(dm: DMChannel) {
    navDrawer.open = false;
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
      created_at: new Date().toISOString(),
      // Parse markers locally so mention pills render at once — the WS
      // echo replaces this copy with the server's authoritative list.
      mentions: parseMentionMarkers(text)
    });
    // Attachments go through REST — the WS send-op doesn't carry
    // attachment_ids and presigned URLs need server-side signing anyway.
    // Pure-text messages stay on the WS fast-path.
    if (attachmentIds.length > 0) {
      chatApi.postMessage(cid, text, { nonce, replyToId, attachmentIds })
        .then((real) => messages.upsert(real))
        .catch((e) => {
          messages.removeOptimistic(cid, tmpId);
          toast.error(m.dm_page_send_failed(), { description: (e as Error).message });
        });
      return;
    }
    const queued = gateway.send(cid, text, nonce, replyToId);
    if (!queued) {
      messages.removeOptimistic(cid, tmpId);
      toast.error(m.dm_page_no_connection());
      return;
    }
    const handle = setTimeout(() => {
      pendingOptimisticTimeouts.delete(nonce);
      if (!messages.isConfirmed(nonce)) {
        messages.removeOptimistic(cid, tmpId);
        toast.error(m.dm_page_message_send_timeout());
      }
    }, 10_000);
    pendingOptimisticTimeouts.set(nonce, handle);
  }

  async function editMessage(msg: Message, content: string) {
    try {
      await chatApi.editMessage(msg.id, content);
    } catch (e) {
      toast.error(m.dm_page_edit_failed());
      console.error(e);
    }
  }

  async function deleteMessage(msg: Message) {
    if (!confirm(m.dm_page_delete_confirm())) return;
    try {
      await chatApi.deleteMessage(msg.id);
    } catch (e) {
      toast.error(m.dm_page_delete_failed());
      console.error(e);
    }
  }

  async function toggleReaction(msg: Message, emoji: string, currentlyMine: boolean) {
    try {
      if (currentlyMine) {
        await chatApi.removeReaction(msg.id, emoji);
      } else {
        await chatApi.addReaction(msg.id, emoji);
      }
    } catch (e) {
      toast.error(m.dm_page_reaction_failed());
      console.error(e);
    }
  }
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={currentServerUserId()}
  homeActive={true}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
  onHomeClick={async () => {
    navDrawer.open = !navDrawer.open;
    await goto('/app/@me');
  }}
/>

<!-- DM-Liste: Desktop dauerhaft; Mobil als eigene Spalte rechts der
     Guild-Rail, sobald der Drawer offen ist — In-Flow, kein Overlay. -->
{#if !viewport.isMobile || navDrawer.open}
  <DMChannelList activeDMId={dmChannelId || null} onSelect={selectDM} />
{/if}

<!-- Chat: Desktop dauerhaft; Mobil nur solange der Drawer zu ist. -->
{#if !viewport.isMobile || !navDrawer.open}
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
      headerKind="dm"
      showMemberList={false}
      composerDisabled={activeDM.can_send === false}
      composerDisabledReason={m.dm_page_composer_disabled_reason()}
      onEditMessage={editMessage}
      onDeleteMessage={deleteMessage}
      onToggleReaction={toggleReaction}
    />
  {:else}
    <section
      class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-none p-8 md:rounded-2xl"
      data-testid="dm-empty-state"
    >
      <p class="text-text-bright text-base font-semibold">{m.dm_page_empty_title()}</p>
      <p class="text-text-muted max-w-sm text-center text-sm">
        {m.dm_page_empty_hint()}
      </p>
    </section>
  {/if}
{/if}
