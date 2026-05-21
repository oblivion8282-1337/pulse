<script lang="ts">
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import HashIcon from '@lucide/svelte/icons/hash';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import { goto } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { voiceState } from '$lib/voice/state.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { watchPartyPresence } from '$lib/stores/watchPartyPresence.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { detachedStreams } from '$lib/stream/detach.svelte';
  import { detachedWatchParties } from '$lib/stream/watchPartyDetach.svelte';
  import { userIdFromIdentity } from '$lib/voice/identity';
  import { readState } from '$lib/stores/readState.svelte';
  import { chatApi } from '$lib/api/chat';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { roles } from '$lib/stores/roles.svelte';
  import { Perm } from '$lib/permissions/bitfield';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  import type { Channel, Guild } from '$lib/api/types';
  import InviteDialog from './InviteDialog.svelte';
  import RenameChannelDialog from './RenameChannelDialog.svelte';
  import VoiceChannelMembers from './VoiceChannelMembers.svelte';
  import SidebarFooter from './SidebarFooter.svelte';

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
  let deleteTarget = $state<Channel | null>(null);
  let deleteConfirmOpen = $state(false);
  let deleteBusy = $state(false);

  let textChannels = $derived(channels.filter((c) => c.type === 0));
  let voiceChannels = $derived(channels.filter((c) => c.type === 1));
  let canManagePermissions = $derived(
    !!guild && roles.hasGuildPermission(guild.id, Perm.MANAGE_PERMISSIONS)
  );

  // Invite button visibility — anyone with CREATE_INVITES (owner gets it
  // implicitly via the resolver's GRANT_ALL_SAFE short-circuit). The
  // server-wide allow_member_invites toggle stays the secondary gate
  // mirroring routes/invites.py.
  const canInvite = $derived(
    !!guild && roles.hasGuildPermission(guild.id, Perm.CREATE_INVITES)
      && (auth.user?.id === guild.owner_id || capabilities.allowMemberInvites)
  );

  function openRename(c: Channel) {
    renameChannel = c;
  }

  // Discord-style: clicking a voice channel joins it. connect() must run from
  // this user gesture so the browser allows the AudioContext to start.
  function selectChannel(c: Channel) {
    if (c.type === 1 && voice.channelId !== c.id) {
      voice.connect(c.id, c.name).catch((e) => {
        toast.error('Voice-Verbindung fehlgeschlagen', {
          description: e instanceof Error ? e.message : String(e)
        });
      });
    }
    onSelect(c);
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
      toast.error('Kanal löschen fehlgeschlagen', { description: (err as Error).message });
    } finally {
      deleteBusy = false;
    }
  }
</script>

<aside class="glass-panel text-text-base flex h-full w-full flex-col overflow-hidden rounded-none md:w-60 md:rounded-2xl lg:w-68" data-testid="channel-list">
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
          aria-label="Leute einladen"
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
          aria-label="Kanal erstellen"
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

  <AlertDialog.Root bind:open={deleteConfirmOpen}>
    <AlertDialog.Content data-testid="delete-channel-dialog">
      <AlertDialog.Header>
        <AlertDialog.Title>Kanal löschen?</AlertDialog.Title>
        <AlertDialog.Description>
          #{deleteTarget?.name} wird dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel disabled={deleteBusy}>Abbrechen</AlertDialog.Cancel>
        <AlertDialog.Action
          onclick={confirmDelete}
          disabled={deleteBusy}
          data-testid="delete-channel-confirm"
        >
          {deleteBusy ? 'Löschen…' : 'Löschen'}
        </AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>

  <nav class="flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
    <div class="text-text-muted px-2.5 pb-1 pt-3 text-xs font-bold">Text-Kanäle</div>
    {#each textChannels as c (c.id)}
      {@const isUnread = activeChannelId !== c.id && readState.isUnread(c.id)}
      {@const mentionCount = activeChannelId !== c.id ? readState.getMentionCount(c.id) : 0}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="group flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left text-sm font-medium transition-colors md:py-2 hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
              data-active={activeChannelId === c.id}
              data-unread={isUnread}
              onclick={() => onSelect(c)}
              data-testid={`channel-${c.id}`}
            >
              <HashIcon class="text-text-muted size-[17px] shrink-0 group-data-[active=true]:text-primary group-data-[unread=true]:text-text-bright" />
              <span class="truncate {isUnread ? 'font-semibold text-text-bright' : ''}">{c.name}</span>
              {#if mentionCount > 0}
                <span
                  class="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white"
                  data-testid="channel-mention-pill"
                  data-mention-count={mentionCount}
                  aria-label="{mentionCount} ungelesene Erwähnung(en)"
                >{mentionCount > 99 ? '99+' : mentionCount}</span>
              {:else if isUnread}
                <span
                  class="ml-auto size-2 shrink-0 rounded-full bg-primary"
                  data-testid="channel-unread-dot"
                  aria-label="ungelesen"
                ></span>
              {/if}
            </button>
          {/snippet}
        </ContextMenu.Trigger>
        {#if canCreate || canManagePermissions}
          <ContextMenu.Content>
            {#if canCreate}
              <ContextMenu.Item onSelect={() => openRename(c)}>
                <PencilIcon />
                Kanal umbenennen
              </ContextMenu.Item>
            {/if}
            {#if canManagePermissions && guild}
              <ContextMenu.Item
                onSelect={() => goto(`/app/guilds/${guild!.id}/channels/${c.id}/permissions`)}
                data-testid={`channel-permissions-${c.id}`}
              >
                <ShieldIcon />
                Berechtigungen
              </ContextMenu.Item>
            {/if}
            {#if canCreate}
              <ContextMenu.Separator />
              <ContextMenu.Item variant="destructive" onSelect={() => openDelete(c)}>
                <Trash2Icon />
                Kanal löschen
              </ContextMenu.Item>
            {/if}
          </ContextMenu.Content>
        {/if}
      </ContextMenu.Root>
    {/each}
    {#if textChannels.length === 0}
      <p class="text-text-muted px-3 py-2 text-xs">Noch keine Text-Kanäle.</p>
    {/if}

    <div class="text-text-muted px-2.5 pb-1 pt-4 text-xs font-bold">Sprach-Kanäle</div>
    {#each voiceChannels as c (c.id)}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="group flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left text-sm font-medium transition-colors md:py-2 hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
              data-active={activeChannelId === c.id}
              onclick={() => selectChannel(c)}
              data-testid={`channel-${c.id}`}
            >
              <Volume2Icon class="text-text-muted size-[17px] shrink-0 group-data-[active=true]:text-primary" />
              <span class="truncate">{c.name}</span>
              {#if voiceState.channelId === c.id && voiceState.connected}
                <span class="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" title="verbunden"></span>
              {/if}
            </button>
          {/snippet}
        </ContextMenu.Trigger>
        {#if canCreate || canManagePermissions}
          <ContextMenu.Content>
            {#if canCreate}
              <ContextMenu.Item onSelect={() => openRename(c)}>
                <PencilIcon />
                Kanal umbenennen
              </ContextMenu.Item>
            {/if}
            {#if canManagePermissions && guild}
              <ContextMenu.Item
                onSelect={() => goto(`/app/guilds/${guild!.id}/channels/${c.id}/permissions`)}
                data-testid={`channel-permissions-${c.id}`}
              >
                <ShieldIcon />
                Berechtigungen
              </ContextMenu.Item>
            {/if}
            {#if canCreate}
              <ContextMenu.Separator />
              <ContextMenu.Item variant="destructive" onSelect={() => openDelete(c)}>
                <Trash2Icon />
                Kanal löschen
              </ContextMenu.Item>
            {/if}
          </ContextMenu.Content>
        {/if}
      </ContextMenu.Root>
      {@const members = voicePresence.usersIn(c.id)}
      {#if members.length > 0}
        {@const streamers = [
          ...new Set([...voicePresence.streamingIn(c.id), ...streamPresence.streamersIn(c.id)]),
        ]}
        {@const speakers =
          voice.connected && voice.channelId === c.id
            ? voice.participants.filter((p) => p.isSpeaking && p.userId).map((p) => p.userId!)
            : []}
        {@const memberStates = voicePresence.userStatesIn(c.id)}
        {@const partyHostId = watchPartyPresence.partyIn(c.id)?.host_user_id ?? null}
        {@const camUserMap =
          voice.connected && voice.channelId === c.id
            ? new Map(
                voice.cameraTracks
                  .map((ct) => [userIdFromIdentity(ct.identity), ct.identity] as const)
                  .filter(([uid]) => uid !== null) as [string, string][]
              )
            : new Map<string, string>()}
        <div class="ml-4 flex flex-col" data-testid="voice-presence-list" data-channel-id={c.id}>
          <VoiceChannelMembers
            userIds={members}
            channelId={c.id}
            guildId={c.guild_id}
            streamingUserIds={streamers}
            camUserIds={[...camUserMap.keys()]}
            speakingUserIds={speakers}
            watchPartyHostUserId={partyHostId}
            userStates={memberStates}
            onPartyOpen={() => {
              if (detachedWatchParties.has(c.id)) detachedWatchParties.open(c.id);
              else openedTiles.openParty(c.id);
              onSelect(c);
            }}
            onLiveOpen={(uid) => {
              // Open whichever live source(s) this user actually has.
              if (streamPresence.streamersIn(c.id).includes(uid)) {
                if (detachedStreams.has(c.id, uid)) detachedStreams.open(c.id, uid);
                else openedTiles.open('hq', c.id, uid);
              }
              if (voicePresence.streamingIn(c.id).includes(uid)) {
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
              const ident = camUserMap.get(uid);
              if (ident) openedTiles.open('cam', c.id, ident);
              onSelect(c);
            }}
          />
        </div>
      {/if}
    {/each}
    {#if voiceChannels.length === 0}
      <p class="text-text-muted px-3 py-2 text-xs">Noch keine Sprach-Kanäle.</p>
    {/if}
  </nav>

  <SidebarFooter />
</aside>
