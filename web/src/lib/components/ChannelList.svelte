<script lang="ts">
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import HashIcon from '@lucide/svelte/icons/hash';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import UserPlusIcon from '@lucide/svelte/icons/user-plus';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { voiceState } from '$lib/voice/state.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { streamOpenRequest } from '$lib/stores/streamOpenRequest.svelte';
  import { readState } from '$lib/stores/readState.svelte';
  import { chatApi } from '$lib/api/chat';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  import type { Channel, Guild } from '$lib/api/types';
  import InviteDialog from './InviteDialog.svelte';
  import RenameChannelDialog from './RenameChannelDialog.svelte';
  import VoiceChannelMembers from './VoiceChannelMembers.svelte';
  import VoiceControlBar from './VoiceControlBar.svelte';
  import UserFooter from './UserFooter.svelte';

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

<aside class="glass-panel text-text-base flex h-full w-72 flex-col overflow-hidden rounded-none md:w-56 md:rounded-2xl lg:w-64" data-testid="channel-list">
  <header class="flex h-12 items-center justify-between px-4 pt-3 text-text-bright">
    <span class="truncate text-base font-bold tracking-tight">{guild?.name ?? '—'}</span>
    <div class="flex items-center gap-0.5">
      {#if guild}
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-text-muted hover:text-primary"
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
          class="text-text-muted hover:text-primary"
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
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
              data-active={activeChannelId === c.id}
              data-unread={isUnread}
              onclick={() => onSelect(c)}
              data-testid={`channel-${c.id}`}
            >
              <HashIcon class="text-text-muted size-[17px] shrink-0 group-data-[active=true]:text-primary group-data-[unread=true]:text-text-bright" />
              <span class="truncate {isUnread ? 'font-semibold text-text-bright' : ''}">{c.name}</span>
              {#if isUnread}
                <span
                  class="ml-auto size-2 shrink-0 rounded-full bg-primary"
                  data-testid="channel-unread-dot"
                  aria-label="ungelesen"
                ></span>
              {/if}
            </button>
          {/snippet}
        </ContextMenu.Trigger>
        {#if canCreate}
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => openRename(c)}>
              <PencilIcon />
              Kanal umbenennen
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item variant="destructive" onSelect={() => openDelete(c)}>
              <Trash2Icon />
              Kanal löschen
            </ContextMenu.Item>
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
              class="group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-bg-hover hover:text-text-bright data-[active=true]:bg-[var(--accent-soft)] data-[active=true]:font-semibold data-[active=true]:text-primary"
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
        {#if canCreate}
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => openRename(c)}>
              <PencilIcon />
              Kanal umbenennen
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item variant="destructive" onSelect={() => openDelete(c)}>
              <Trash2Icon />
              Kanal löschen
            </ContextMenu.Item>
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
        <div class="ml-4 flex flex-col" data-testid="voice-presence-list" data-channel-id={c.id}>
          <VoiceChannelMembers
            userIds={members}
            streamingUserIds={streamers}
            speakingUserIds={speakers}
            userStates={memberStates}
            onStreamClick={() => {
              // The badge passes the streamer's uid but v1 just opens the
              // channel's stream view (auto-focuses the first streamer).
              streamOpenRequest.request(c.id);
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

  {#if voice.connected || voice.connecting}
    <VoiceControlBar />
  {/if}
  <UserFooter />
</aside>
