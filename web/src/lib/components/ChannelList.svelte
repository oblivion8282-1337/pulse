<script lang="ts">
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import HashIcon from '@lucide/svelte/icons/hash';
  import LockIcon from '@lucide/svelte/icons/lock';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import ZapIcon from '@lucide/svelte/icons/zap';
  import ZapOffIcon from '@lucide/svelte/icons/zap-off';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import { goto } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { voiceAutoConnect } from '$lib/voice/autoconnect.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { inVoiceChannel } from '$lib/voice/state.svelte';
  import { voicePresence, type UserVoiceState } from '$lib/stores/voicePresence.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { watchPartyPicker, openPartyTile } from '$lib/watch/openParty.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { readState } from '$lib/stores/readState.svelte';
  import { chatApi } from '$lib/api/chat';
  import { reorderChannel } from '$lib/channels/reorder';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  import { ensureGuildPluginsLoaded } from '$lib/plugins';
  import type { Channel, Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import InviteDialog from './InviteDialog.svelte';
  import RenameChannelDialog from './RenameChannelDialog.svelte';
  import ReportMessageDialog from './chat/ReportMessageDialog.svelte';
  import VoiceChannelMembers from './VoiceChannelMembers.svelte';
  import SidebarFooter from './SidebarFooter.svelte';

  const CHANNEL_BTN_CLASS =
    'group flex w-full items-center gap-3 rounded-xl px-3 py-4 text-left text-base font-medium transition-colors md:gap-2.5 md:py-2 md:text-sm hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary';

  let {
    guild,
    channels,
    activeChannelId = null,
    onSelect,
    onCreateClick,
    onChannelDeleted,
    canCreate = false
  }: {
    guild: Guild | null;
    channels: Channel[];
    activeChannelId?: string | null;
    onSelect: (c: Channel) => void;
    onCreateClick: () => void;
    onChannelDeleted?: (channelId: string) => void;
    canCreate?: boolean;
  } = $props();

  let inviteOpen = $state(false);
  let renameChannel = $state<Channel | null>(null);
  let reportChannel = $state<Channel | null>(null);
  let deleteTarget = $state<Channel | null>(null);
  let deleteConfirmOpen = $state(false);
  let deleteBusy = $state(false);

  let myId = $derived(currentServerUserId());
  // Sorted by position so a drag-reorder (which only changes positions) is
  // reflected immediately. Equal positions keep insertion order (stable sort),
  // matching the server's `order_by(position, id)`.
  let textChannels = $derived(
    channels.filter((c) => c.type === 0).sort((a, b) => a.position - b.position)
  );
  let voiceChannels = $derived(
    channels.filter((c) => c.type === 1).sort((a, b) => a.position - b.position)
  );

  // Pro-Guild Plugin-Aktivierungen laden, sobald wir wissen, welche Guild
  // aktiv ist. Idempotent — der Store fetched nur einmal pro Guild bis
  // ein explizites `refreshGuildPlugins` reinkommt.
  $effect(() => {
    if (guild?.id) void ensureGuildPluginsLoaded(guild.id);
  });
  let canManagePermissions = $derived(
    !!guild && roles.hasGuildPermission(guild.id, Perm.MANAGE_PERMISSIONS)
  );
  // Drag-to-reorder is gated on MANAGE_CHANNELS (same as create/rename/delete).
  let canManageChannels = $derived(
    !!guild && roles.hasGuildPermission(guild.id, Perm.MANAGE_CHANNELS)
  );

  // Channel drag-and-drop. `dragId` is the channel being moved; `dragOverId`
  // is the row we'd drop onto. Dropping is constrained to the same type group.
  let dragId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null);

  function onChannelDragStart(e: DragEvent, c: Channel) {
    if (!canManageChannels || !e.dataTransfer) return;
    dragId = c.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', c.id);
  }
  function onChannelDragOver(e: DragEvent, c: Channel) {
    if (!dragId || dragId === c.id) return;
    const src = channels.find((x) => x.id === dragId);
    if (!src || src.type !== c.type) return; // only within the same group
    e.preventDefault();
    dragOverId = c.id;
  }
  async function onChannelDrop(e: DragEvent, target: Channel) {
    e.preventDefault();
    const sourceId = dragId;
    dragId = null;
    dragOverId = null;
    if (!sourceId || !guild) return;
    const src = channels.find((x) => x.id === sourceId);
    if (!src || src.type !== target.type) return;
    const group = src.type === 1 ? voiceChannels : textChannels;
    try {
      await reorderChannel(group, sourceId, target.id, guild.id);
    } catch (err) {
      toast.error(m.channel_list_reorder_failed(), {
        description: (err as Error).message
      });
    }
  }
  function onChannelDragEnd() {
    dragId = null;
    dragOverId = null;
  }

  // Invite button visibility — anyone with CREATE_INVITES (owner gets it
  // implicitly via the resolver's GRANT_ALL_SAFE short-circuit). The
  // server-wide allow_member_invites toggle stays the secondary gate
  // mirroring routes/invites.py.
  const canInvite = $derived(
    !!guild && roles.hasGuildPermission(guild.id, Perm.CREATE_INVITES)
      && (myId === guild.owner_id || capabilities.allowMemberInvites)
  );

  function openRename(c: Channel) {
    renameChannel = c;
  }

  // Discord-style: clicking a voice channel joins it. connect() must run from
  // this user gesture so the browser allows the AudioContext to start.
  function selectChannel(c: Channel) {
    if (c.type === 1 && voice.channelId !== c.id) {
      voice.connect(c.id, c.name).catch((e) => {
        toast.error(m.channel_list_voice_connect_failed(), {
          description: e instanceof Error ? e.message : String(e)
        });
      });
    }
    onSelect(c);
  }

  // Mute/Deafen für die Liste: Basis ist die Server-Presence (einzige Quelle
  // für Kanäle, in denen wir nicht sind). Für den Kanal, mit dem wir VERBUNDEN
  // sind, überlagern wir das Live-Mute aus dem LiveKit-Store — so ist die Liste
  // deckungsgleich mit der mittleren VoiceChannelView (auch bei OS-Mutes beim
  // Handy-Sperren, die nie über die Server-Presence laufen). Remote-Deafen
  // kennt LiveKit nicht (reines App-Flag) → bleibt aus der Presence; das eigene
  // Deafen ziehen wir live. Berührt NUR die Mute-Anzeige, nicht die
  // Mitgliederliste (die kommt weiter aus voicePresence.usersIn).
  function memberStatesFor(channelId: string): Record<string, UserVoiceState> {
    const base = voicePresence.userStatesIn(channelId);
    if (!(voice.connected && voice.channelId === channelId)) return base;
    const merged: Record<string, UserVoiceState> = { ...base };
    for (const p of voice.participants) {
      if (!p.userId) continue;
      merged[p.userId] = {
        mic_muted: p.micMuted,
        deafened: p.isLocal ? voice.deafened : (merged[p.userId]?.deafened ?? false)
      };
    }
    return merged;
  }

  // Auto-Connect-Wahl (gerätelokal, an User + Server gebunden). Es kann nur
  // EINEN Auto-Connect-Channel pro Gerät geben — Setzen verschiebt den Blitz.
  function toggleAutoConnect(c: Channel) {
    if (voiceAutoConnect.isTarget(c.id)) {
      voiceAutoConnect.clear();
    } else {
      if (!myId) return; // ohne aufgelöste User-ID keine Account-Bindung möglich
      voiceAutoConnect.set({
        serverId: activeServer.serverId,
        userId: myId,
        channelId: c.id,
        channelName: c.name,
        guildId: c.guild_id
      });
    }
  }

  function openDelete(c: Channel) {
    deleteTarget = c;
    deleteConfirmOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    deleteBusy = true;
    try {
      await chatApi.deleteChannel(id);
      // Eager local cleanup — the channel_deleted WS broadcast does the same
      // for every other client (and us again, harmlessly).
      guilds.removeChannel(id);
      gateway.unsubscribe(id);
      messages.clearChannel(id);
      onChannelDeleted?.(id);
      deleteConfirmOpen = false;
      deleteTarget = null;
    } catch (err) {
      toast.error(m.channel_list_delete_channel_failed(), { description: (err as Error).message });
    } finally {
      deleteBusy = false;
    }
  }
</script>

<aside class="glass-panel text-text-base flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:w-60 md:flex-none md:rounded-2xl lg:w-68" data-testid="channel-list">
  <header class="flex h-12 items-center justify-between px-4 pt-3 text-text-bright">
    <span class="truncate text-base font-bold tracking-tight">{guild?.name ?? '—'}</span>
    <div class="flex items-center gap-0.5">
      {#if guild && canInvite}
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-9 md:size-8 text-text-muted hover:text-primary"
          onclick={() => (inviteOpen = true)}
          data-testid="invite-open-btn"
          aria-label={m.channel_list_invite_people()}
        >
          <UserPlusIcon />
        </Button>
      {/if}
      {#if canCreate}
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-9 md:size-8 text-text-muted hover:text-primary"
          onclick={onCreateClick}
          data-testid="channel-create"
          aria-label={m.channel_list_create_channel()}
        >
          <PlusIcon />
        </Button>
      {/if}
    </div>
  </header>

  {#if guild}
    <InviteDialog
      open={inviteOpen}
      guildId={guild.id}
      onClose={() => (inviteOpen = false)}
    />
  {/if}

  <RenameChannelDialog
    open={renameChannel !== null}
    channel={renameChannel}
    onClose={() => (renameChannel = null)}
  />

  {#if reportChannel}
    <ReportMessageDialog
      kind="channel"
      channelId={reportChannel.id}
      open={true}
      onClose={() => (reportChannel = null)}
    />
  {/if}

  <AlertDialog.Root bind:open={deleteConfirmOpen}>
    <AlertDialog.Content data-testid="delete-channel-dialog">
      <AlertDialog.Header>
        <AlertDialog.Title>{m.channel_list_delete_dialog_title()}</AlertDialog.Title>
        <AlertDialog.Description>
          {m.channel_list_delete_dialog_description({ name: deleteTarget?.name ?? '' })}
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel disabled={deleteBusy}>{m.channel_list_cancel()}</AlertDialog.Cancel>
        <AlertDialog.Action
          onclick={confirmDelete}
          disabled={deleteBusy}
          data-testid="delete-channel-confirm"
        >
          {deleteBusy ? m.channel_list_deleting() : m.channel_list_delete()}
        </AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>

  <nav class="flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
    <div class="text-text-muted px-2.5 pb-1 pt-3 text-sm font-bold md:text-xs">{m.channel_list_text_channels()}</div>
    {#each textChannels as c (c.id)}
      {@const isUnread = activeChannelId !== c.id && readState.isUnread(c.id)}
      {@const mentionCount = activeChannelId !== c.id ? readState.getMentionCount(c.id) : 0}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="{CHANNEL_BTN_CLASS} {dragOverId === c.id
                ? 'border-t-2 border-primary'
                : ''} {dragId === c.id ? 'opacity-50' : ''}"
              data-active={activeChannelId === c.id}
              data-unread={isUnread}
              onclick={() => onSelect(c)}
              draggable={canManageChannels}
              ondragstart={(e) => onChannelDragStart(e, c)}
              ondragover={(e) => onChannelDragOver(e, c)}
              ondrop={(e) => onChannelDrop(e, c)}
              ondragend={onChannelDragEnd}
              data-testid={`channel-${c.id}`}
            >
              <HashIcon class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary group-data-[unread=true]:text-text-bright" />
              <span class="truncate {isUnread ? 'font-semibold text-text-bright' : ''}">{c.name}</span>
              <span class="ml-auto flex shrink-0 items-center gap-1.5">
                {#if c.restricted}
                  <LockIcon
                    class="text-text-muted size-4 md:size-3.5"
                    data-testid={`channel-lock-${c.id}`}
                    aria-label={m.channel_list_restricted()}
                  />
                {/if}
                {#if mentionCount > 0}
                  <span
                    class="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white"
                    data-testid="channel-mention-pill"
                    data-mention-count={mentionCount}
                    aria-label={m.channel_list_unread_mentions({ count: mentionCount })}
                  >{mentionCount > 99 ? '99+' : mentionCount}</span>
                {:else if isUnread}
                  <span
                    class="size-2 shrink-0 rounded-full bg-primary"
                    data-testid="channel-unread-dot"
                    aria-label={m.channel_list_unread()}
                  ></span>
                {/if}
              </span>
            </button>
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          {#if canCreate}
            <ContextMenu.Item onSelect={() => openRename(c)}>
              <PencilIcon />
              {m.channel_list_rename_channel()}
            </ContextMenu.Item>
          {/if}
          {#if canManagePermissions && guild}
            <ContextMenu.Item
              onSelect={() => goto(`/app/guilds/${guild!.id}/channels/${c.id}/permissions`)}
              data-testid={`channel-permissions-${c.id}`}
            >
              <ShieldIcon />
              {m.channel_list_permissions()}
            </ContextMenu.Item>
          {/if}
          <!-- Melden steht jedem Mitglied offen, nicht nur Managern. -->
          <ContextMenu.Item
            onSelect={() => (reportChannel = c)}
            data-testid={`channel-report-${c.id}`}
          >
            <FlagIcon />
            {m.channel_list_report()}
          </ContextMenu.Item>
          {#if canCreate}
            <ContextMenu.Separator />
            <ContextMenu.Item variant="destructive" onSelect={() => openDelete(c)}>
              <Trash2Icon />
              {m.channel_list_delete_channel()}
            </ContextMenu.Item>
          {/if}
        </ContextMenu.Content>
      </ContextMenu.Root>
    {/each}
    {#if textChannels.length === 0}
      <p class="text-text-muted px-3 py-2 text-xs">{m.channel_list_no_text_channels()}</p>
    {/if}

    <div class="text-text-muted px-2.5 pb-1 pt-4 text-sm font-bold md:text-xs">{m.channel_list_voice_channels()}</div>
    {#each voiceChannels as c (c.id)}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="{CHANNEL_BTN_CLASS} {dragOverId === c.id
                ? 'border-t-2 border-primary'
                : ''} {dragId === c.id ? 'opacity-50' : ''}"
              data-active={activeChannelId === c.id}
              onclick={() => selectChannel(c)}
              draggable={canManageChannels}
              ondragstart={(e) => onChannelDragStart(e, c)}
              ondragover={(e) => onChannelDragOver(e, c)}
              ondrop={(e) => onChannelDrop(e, c)}
              ondragend={onChannelDragEnd}
              data-testid={`channel-${c.id}`}
            >
              <Volume2Icon class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary" />
              <span class="truncate">{c.name}</span>
              <span class="ml-auto flex shrink-0 items-center gap-1.5">
                {#if c.restricted}
                  <LockIcon
                    class="text-text-muted size-4 md:size-3.5"
                    data-testid={`channel-lock-${c.id}`}
                    aria-label={m.channel_list_restricted()}
                  />
                {/if}
                {#if voiceAutoConnect.isTarget(c.id)}
                  <span
                    class="shrink-0"
                    title={m.channel_list_autoconnect_marker()}
                    data-testid={`channel-autoconnect-${c.id}`}
                  >
                    <ZapIcon class="size-4 text-primary md:size-3.5" aria-label={m.channel_list_autoconnect_marker()} />
                  </span>
                {/if}
                {#if inVoiceChannel(c.id)}
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" title={m.channel_list_connected()}></span>
                {/if}
              </span>
            </button>
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <!-- Für alle Mitglieder, nicht nur Admins: Auto-Connect-Wahl. -->
          <ContextMenu.Item
            onSelect={() => toggleAutoConnect(c)}
            data-testid={`channel-autoconnect-toggle-${c.id}`}
          >
            {#if voiceAutoConnect.isTarget(c.id)}
              <ZapOffIcon />
              {m.channel_list_autoconnect_remove()}
            {:else}
              <ZapIcon />
              {m.channel_list_autoconnect_set()}
            {/if}
          </ContextMenu.Item>
          {#if canCreate}
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => openRename(c)}>
              <PencilIcon />
              {m.channel_list_rename_channel()}
            </ContextMenu.Item>
          {/if}
          {#if canManagePermissions && guild}
            <ContextMenu.Item
              onSelect={() => goto(`/app/guilds/${guild!.id}/channels/${c.id}/permissions`)}
              data-testid={`channel-permissions-${c.id}`}
            >
              <ShieldIcon />
              {m.channel_list_permissions()}
            </ContextMenu.Item>
          {/if}
          <ContextMenu.Item
            onSelect={() => (reportChannel = c)}
            data-testid={`channel-report-${c.id}`}
          >
            <FlagIcon />
            {m.channel_list_report()}
          </ContextMenu.Item>
          {#if canCreate}
            <ContextMenu.Separator />
            <ContextMenu.Item variant="destructive" onSelect={() => openDelete(c)}>
              <Trash2Icon />
              {m.channel_list_delete_channel()}
            </ContextMenu.Item>
          {/if}
        </ContextMenu.Content>
      </ContextMenu.Root>
      {@const members = voicePresence.usersIn(c.id)}
      {#if members.length > 0}
        {@const voiceStreamers = voicePresence.streamingIn(c.id)}
        {@const streamers = [
          ...new Set([...voiceStreamers, ...streamPresence.streamersIn(c.id)]),
        ]}
        {@const speakers =
          voice.connected && voice.channelId === c.id
            ? voice.participants.filter((p) => p.isSpeaking && p.userId).map((p) => p.userId!)
            : []}
        {@const memberStates = memberStatesFor(c.id)}
        {@const partyHostIds = watchPartyPresence.hostIdsIn(c.id)}
        <!-- Who has their webcam on — server-tracked (voice:events), so the CAM
             badge shows for everyone incl. ourselves and even when we're not
             connected to this channel. Opening the cam tile still needs a
             subscribed track, which only exists while connected. -->
        {@const camUserIds = voicePresence.cameraIn(c.id)}
        {@const camIdentityFor = (uid: string) =>
          !(voice.connected && voice.channelId === c.id)
            ? undefined
            : uid === myId
              ? 'self' // own preview tile uses the 'self' sentinel id (StreamGrid)
              : voice.cameraTracks.find((ct) => userIdFromIdentity(ct.identity) === uid)?.identity}
        <div class="ml-4 flex flex-col" data-testid="voice-presence-list" data-channel-id={c.id}>
          <VoiceChannelMembers
            userIds={members}
            channelId={c.id}
            guildId={c.guild_id}
            streamingUserIds={streamers}
            camUserIds={camUserIds}
            speakingUserIds={speakers}
            watchPartyHostUserIds={partyHostIds}
            userStates={memberStates}
            onPartyOpen={(uid) => {
              watchPartyPicker.choose(
                watchPartyPresence.partiesHostedBy(c.id, uid).map((party) => ({
                  id: party.party_id,
                  party,
                  open: () => {
                    openPartyTile(c.id, party);
                    onSelect(c);
                  }
                })),
                m.watch_party_picker_title()
              );
            }}
            onLiveOpen={(uid) => {
              // Open whichever live source(s) this user actually has.
              if (streamers.includes(uid)) {
                if (detachedStreams.has(c.id, uid)) detachedStreams.open(c.id, uid);
                else openedTiles.open('hq', c.id, uid);
              }
              if (voiceStreamers.includes(uid)) {
                // Screen-share keyed by LiveKit identity — only available
                // if we're connected to this channel. Outside that, the
                // tile can't mount anyway (no subscribed track).
                const ident = voice.connected && voice.channelId === c.id
                  ? voice.screenTracks.find((s) => userIdFromIdentity(s.identity) === uid)?.identity
                  : undefined;
                if (ident) openedTiles.open('screen', c.id, ident);
              }
              onSelect(c);
            }}
            onCamOpen={(uid) => {
              const ident = camIdentityFor(uid);
              if (ident) openedTiles.open('cam', c.id, ident);
              onSelect(c);
            }}
          />
        </div>
      {/if}
    {/each}
    {#if voiceChannels.length === 0}
      <p class="text-text-muted px-3 py-2 text-xs">{m.channel_list_no_voice_channels()}</p>
    {/if}
  </nav>

  <SidebarFooter />
</aside>
