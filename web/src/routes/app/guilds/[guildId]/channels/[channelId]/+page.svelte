<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ChannelList from '$lib/components/ChannelList.svelte';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import VoiceChannelView from '$lib/components/VoiceChannelView.svelte';
  import MobileVoiceStack from '$lib/components/MobileVoiceStack.svelte';
  import { isPluginEnabledForGuild } from '$lib/plugins';
  import TamagotchiWidget from '../../../../../../../../plugins/tamagotchi/components/TamagotchiWidget.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import CreateGuildDialog from '$lib/components/CreateGuildDialog.svelte';
  import CreateChannelDialog from '$lib/components/CreateChannelDialog.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { guildSounds } from '$lib/stores/guildSounds.svelte';
  import { channelPermissions } from '$lib/stores/channelPermissions.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { chatApi } from '$lib/api/chat';
  import { rolesApi } from '$lib/api/roles';
  import { joinGuildByInvite } from '$lib/guilds/joinByInvite';
  import { gateway } from '$lib/ws/connection';
  import { useGatewayDeletedListener } from '$lib/ws/useGatewayListener.svelte';
  import { voice } from '$lib/voice/livekit.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { navDrawer } from '$lib/stores/navDrawer.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { parseMentionMarkers } from '$lib/components/messageRender';
  import { toast } from 'svelte-sonner';
  import type { Channel, Message } from '$lib/api/types';
  import { m as pm } from '$lib/paraglide/messages.js';

  let guildId = $derived(page.params.guildId ?? '');
  let channelId = $derived(page.params.channelId ?? '');
  let activeGuild = $derived<typeof guilds.byId[string] | undefined>(guilds.byId[guildId]);
  let channelsForGuild = $derived<Channel[]>(guilds.channelsByGuild[guildId] ?? []);
  let activeChannel = $derived<Channel | null>(
    channelsForGuild.find((c: Channel) => c.id === channelId) ?? null
  );
  let isVoiceChannel = $derived(activeChannel?.type === 1);
  // Mobil + im Voice + Text-Kanal derselben Community angesehen → Karten-Stapel.
  let connectedVoiceChannel = $derived<Channel | null>(
    voice.connected && voice.channelId
      ? (channelsForGuild.find((c: Channel) => c.id === voice.channelId) ?? null)
      : null
  );
  let showVoiceStack = $derived(
    viewport.isMobile &&
      !!connectedVoiceChannel &&
      connectedVoiceChannel.id !== channelId &&
      activeChannel?.type === 0
  );

  // Auf Mobil hat ein Voice-Kanal keine eigene Vollbild-Seite: stattdessen
  // bleibt die Kanal-Liste sichtbar (oben Text-, unten Sprachkanäle). Zusätzlich
  // Auto-Rejoin beim Laden/Navigieren auf einen Voice-Kanal — sonst ist man nach
  // einem Reload "auf dem Kanal", aber nicht verbunden (→ Text-Kanal zeigt
  // Vollbild statt Karten-Stapel). Spiegelt das frühere
  // VoiceChannelView.onMount-Auto-Join, das mit der Vollbild-Seite entfiel.
  // Nur EINMAL pro Kanal-Landing (Guard) und untracked gelesen — NICHT reaktiv
  // auf Verbindungsabbruch, sonst würde "Verlassen" sofort wieder beitreten;
  // und nur, wenn wir nirgends im Voice sind (kein Auto-Switch).
  let autoJoinedVoiceChannel = '';
  $effect(() => {
    if (!viewport.isMobile || !isVoiceChannel) return;
    navDrawer.open = true;
    const ch = activeChannel;
    if (!ch || autoJoinedVoiceChannel === ch.id) return;
    autoJoinedVoiceChannel = ch.id;
    untrack(() => {
      if (!voice.connected && !voice.connecting) void voice.connect(ch.id, ch.name);
    });
  });
  let visibleMessages = $derived(messages.for(channelId));
  // Server-shared Tamagotchi: nur rendern wenn Plugin für die Guild
  // aktiviert (MANAGE_GUILD-Admin-Toggle, siehe `guildPluginsApi`).
  // Auf Mobil weggelassen — die rechte Sidebar ist dort zu eng.
  let showTamagotchi = $derived(
    !viewport.isMobile &&
      !!guildId &&
      !isVoiceChannel &&
      isPluginEnabledForGuild(guildId, 'tamagotchi')
  );

  let creatingGuild = $state(false);
  // Which screen the add-community dialog opens on (rail "+" menu).
  let createGuildMode = $state<'create' | 'join'>('create');
  let creatingChannel = $state(false);
  let resolving = $state(true);
  let loadError = $state<string | null>(null);

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

  // Direct-load safety net: switchTo only kicks off `channelPermissions.ensure`
  // when `target !== prevC`, which on the very first render is fine, but a
  // page-reload onto `/app/guilds/X/channels/<voice-id>` could otherwise paint
  // before the overwrite list lands (STREAM/USE_VIDEO deny gates would miss).
  // Re-firing on every channelId change is idempotent — `ensure` short-circuits
  // on a cached entry.
  $effect(() => {
    const cid = channelId;
    if (!cid || cid === '_') return;
    void channelPermissions.ensure(cid).catch(() => undefined);
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

  // Phase 4.5: Deleted-Hooks via Helper — wandern beim Server-Switch mit.
  useGatewayDeletedListener({
    onChannel: handleRemoteChannelDeleted,
    onGuild: handleRemoteGuildDeleted,
  });

  onMount(() => {
    // Escape schließt Drawer auf Mobil
    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape' && navDrawer.open) navDrawer.open = false;
    }
    window.addEventListener('keydown', onKeydown);

    return () => {
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
        // `ensureChannels` hits the post-Ready prefetch cache if it ran
        // through; falls back to a single `listChannels` otherwise. The
        // `channel_*` lifecycle events keep the cache live during the
        // session, so this rarely needs to refetch.
        await guilds.ensureChannels(g);
      } catch (err) {
        if (isStale()) return;
        loadError = err instanceof Error ? err.message : pm.channel_page_channels_load_error();
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
      // Lazy-load this channel's permission overwrites so the resolver
      // doesn't false-positive against guild defaults. Best-effort:
      // a 403/500 here would only collapse UI affordances back to the
      // guild-level resolution, which is still correct (just permissive).
      if (ch) void channelPermissions.ensure(ch.id).catch(() => undefined);
      // Only text channels have message history + WS subscriptions.
      // Voice channels are handled entirely by VoiceChannelView/LiveKit.
      if (ch && ch.type === 0) {
        // Cached from an earlier visit? Then its WS subscription lapsed while
        // we were away — re-subscribe + gap-fill below instead of re-fetching.
        const alreadyLoaded = !!messages.loadedChannels[target];
        try {
          if (!alreadyLoaded) {
            const history = await chatApi.listMessages(target);
            if (isStale()) return;
            messages.setInitial(target, history);
          }
        } catch (err) {
          if (isStale()) return;
          loadError = err instanceof Error ? err.message : pm.channel_page_messages_load_error();
          resolving = false;
          return;
        }
        // Only subscribe once this switch is still the active one — otherwise
        // a faster switch already moved on and we'd leak a subscription.
        if (isStale()) return;
        gateway.subscribe(target);
        // Backfill anything that landed while the subscription was dropped.
        if (alreadyLoaded) void gateway.gapFill(target);
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
    // Server-Icon öffnet immer die Kanal-Liste (Gilde → Text- → Sprachkanäle);
    // kein Auf-/Zu-Toggle mehr. Geschlossen wird sie durch Kanal-Auswahl.
    navDrawer.open = true;
    if (id !== guildId) {
      await goto(`/app/guilds/${id}/channels/_`);
    }
  }

  async function selectChannel(c: Channel) {
    // Voice-Kanal auf Mobil: direkt beitreten und die Kanal-Liste offen lassen
    // (keine große Vollbild-Voice-Ansicht). Status erscheint im Dock + inline.
    if (viewport.isMobile && c.type === 1) {
      void voice.connect(c.id, c.name);
      navDrawer.open = true;
      if (c.id !== channelId) await goto(`/app/guilds/${guildId}/channels/${c.id}`);
      return;
    }
    navDrawer.open = false;
    if (c.id === channelId) return;
    await goto(`/app/guilds/${guildId}/channels/${c.id}`);
  }

  async function createGuild(name: string) {
    const g = await chatApi.createGuild(name);
    guilds.add(g);
    // Same role+sound-store seeding rationale as in ``/app/+page.svelte`` —
    // without this the owner's UI gates stay locked until ready rebuilds.
    roles.recomputeGuild(g.id);
    guildSounds.ensureSlot(g.id);
    void rolesApi
      .list(g.id)
      .then((rows) => {
        for (const r of rows) roles.upsertRole(r);
      })
      .catch(() => undefined);
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

  function sendMessage(text: string, replyToId: string | null, attachmentIds: string[]) {
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
      created_at: new Date().toISOString(),
      // Parse markers locally so mention pills render at once — the WS
      // echo replaces this copy with the server's authoritative list.
      mentions: parseMentionMarkers(text)
    });
    // Attachments go through REST — WS send-op carries no attachment_ids,
    // and presigned URLs need server-side signing. Text-only stays on the
    // optimistic WS path for the latency it saves.
    if (attachmentIds.length > 0) {
      chatApi.postMessage(cid, text, { nonce, replyToId, attachmentIds })
        .then((real) => messages.upsert(real))
        .catch((e) => {
          messages.removeOptimistic(cid, tmpId);
          toast.error(pm.channel_page_send_failed(), { description: (e as Error).message });
        });
      return;
    }
    const queued = gateway.send(cid, text, nonce, replyToId);
    if (!queued) {
      // WS not open — roll back the optimistic message and inform the user.
      messages.removeOptimistic(cid, tmpId);
      toast.error(pm.channel_page_no_connection());
      return;
    }
    const handle = setTimeout(() => {
      pendingOptimisticTimeouts.delete(nonce);
      if (!messages.isConfirmed(nonce)) {
        messages.removeOptimistic(cid, tmpId);
        toast.error(pm.channel_page_message_not_sent());
      }
    }, 10_000);
    pendingOptimisticTimeouts.set(nonce, handle);
  }

  async function editMessage(m: Message, content: string) {
    try {
      await chatApi.editMessage(m.id, content);
      // WS broadcasts `message_update` to update local store.
    } catch (e) {
      toast.error(pm.channel_page_edit_failed());
      console.error(e);
    }
  }

  async function deleteMessage(m: Message) {
    if (!confirm(pm.channel_page_confirm_delete_message())) return;
    try {
      await chatApi.deleteMessage(m.id);
      // WS broadcasts `message_delete`.
    } catch (e) {
      toast.error(pm.channel_page_delete_failed());
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
      toast.error(pm.channel_page_reaction_failed());
      console.error(e);
    }
  }
</script>

<!-- Guild-Rail: immer sichtbar (auch Mobil), Discord-Style. -->
<GuildRail
  guilds={guilds.list}
  activeGuildId={guildId}
  currentUserId={auth.user?.id ?? null}
  onSelect={(g) => selectGuild(g.id)}
  onCreateClick={!!auth.user?.is_admin || capabilities.allowGuildCreation
    ? () => { createGuildMode = 'create'; creatingGuild = true; }
    : undefined}
  onJoinClick={() => { createGuildMode = 'join'; creatingGuild = true; }}
  onHomeClick={() => { navDrawer.open = true; void goto('/app/@me'); }}
  onGuildDeleted={(gId) => { if (gId === guildId) void handleRemoteGuildDeleted(gId); }}
/>

<!-- Channel-Liste: Desktop dauerhaft; Mobil als eigene Spalte rechts der
     Guild-Rail, sobald der Drawer offen ist — In-Flow, kein Overlay. -->
{#if !viewport.isMobile || navDrawer.open}
  <ChannelList
    guild={activeGuild ?? null}
    channels={channelsForGuild}
    activeChannelId={activeChannel?.id ?? null}
    onSelect={selectChannel}
    onCreateClick={() => (creatingChannel = true)}
    {onChannelDeleted}
    canCreate={!!activeGuild && roles.hasGuildPermission(activeGuild.id, Perm.MANAGE_CHANNELS)}
  />
{/if}

{#snippet chatBody()}
  <ChatView
    channel={activeChannel}
    messages={visibleMessages}
    onSend={sendMessage}
    isOwner={!!activeGuild && roles.hasGuildPermission(activeGuild.id, Perm.MANAGE_MESSAGES)}
    onEditMessage={editMessage}
    onDeleteMessage={deleteMessage}
    onToggleReaction={toggleReaction}
  />
{/snippet}

<!-- Chat/Voice: Desktop dauerhaft; Mobil nur solange der Drawer zu ist und der
     aktive Kanal kein Voice-Kanal ist (Voice = Liste bleibt, keine Vollbild-Seite). -->
{#if !viewport.isMobile || (!navDrawer.open && !isVoiceChannel)}
  {#if showVoiceStack && connectedVoiceChannel}
    {@const vc = connectedVoiceChannel}
    <MobileVoiceStack
      voiceChannel={vc}
      onReturnToVoice={() => goto(`/app/guilds/${guildId}/channels/${vc.id}`)}
      chat={chatBody}
    />
  {:else if isVoiceChannel && activeChannel}
    {#key activeChannel.id}
      <VoiceChannelView channel={activeChannel} />
    {/key}
  {:else if loadError}
    <section class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 md:rounded-2xl">
      <p class="text-sm text-red-400" data-testid="load-error">{loadError}</p>
      <Button
        onclick={() => { loadError = null; prevGuild = ''; prevChannel = ''; void switchTo(guildId, channelId); }}
        data-testid="load-retry"
      >{pm.channel_page_retry()}</Button>
    </section>
  {:else}
    {@render chatBody()}
  {/if}
{/if}

<!--
  Server-shared Plugin-Rail (rechts neben ChatView/MemberList). Heute nur
  Tamagotchi; ein weiteres Plugin würde sich hier reihen. Bewusst NICHT
  über das alte UI-Slot-Pattern, weil es das erst in einem späteren PR
  geben wird. Mobile + Voice-Channels haben kein Widget — Begründung
  liegt im `showTamagotchi`-Derived oben.

  Die Width-Klasse ist absichtlich schmal (`w-56`) damit die ChatView
  + MemberList den meisten Raum behalten.
-->
{#if showTamagotchi && activeChannel}
  <aside
    class="border-border bg-bg-chat hidden h-full w-56 shrink-0 flex-col gap-2 overflow-y-auto border-l p-2 md:flex md:rounded-2xl md:border-0"
    data-testid="guild-plugin-rail"
  >
    <h2 class="text-text-muted px-2 pt-1 text-xs font-bold uppercase tracking-wide">
      {pm.channel_page_community_pets()}
    </h2>
    <TamagotchiWidget {guildId} />
  </aside>
{/if}

<CreateGuildDialog
  open={creatingGuild}
  canCreate={!!auth.user?.is_admin || capabilities.allowGuildCreation}
  initialMode={createGuildMode}
  onClose={() => (creatingGuild = false)}
  onCreate={createGuild}
  onJoin={joinGuild}
/>

<CreateChannelDialog open={creatingChannel} onClose={() => (creatingChannel = false)} onCreate={createChannel} />
