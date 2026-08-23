<script lang="ts">
  /**
   * Die Textkanäle der Kanalliste.
   *
   * Aus `ChannelList.svelte` herausgelöst (819 Zeilen, harte Grenze 500), als
   * der Mobil-Umbau dieselben Zeilen an drei Stellen brauchte: Vollbild-Liste,
   * Kanal-Wechsler-Sheet und Tablet-Spalte. **Markup unverändert übernommen** —
   * `data-testid`, Klassen und Reihenfolge sind dieselben wie vorher, damit die
   * bestehenden Playwright-Tests weiter greifen.
   */
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import HashIcon from '@lucide/svelte/icons/hash';
  import LockIcon from '@lucide/svelte/icons/lock';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import { goto } from '$app/navigation';
  import { readState } from '$lib/stores/readState.svelte';
  import { channelNameStyle } from '$lib/utils/nameColor';
  import { CHANNEL_BTN_CLASS } from '$lib/channels/stil';
  import {
    KanalZiehen,
    beginnen,
    darueber,
    ablegen,
    beenden,
    type ZiehKontext
  } from '$lib/channels/ziehen.svelte';
  import ChannelTopicTooltip from '../ChannelTopicTooltip.svelte';
  import type { Channel, Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channels,
    guild,
    activeChannelId = null,
    canCreate = false,
    canManagePermissions = false,
    canManageChannels = false,
    ziehen,
    kontext,
    onSelect,
    onRename,
    onDelete,
    onReport
  }: {
    channels: Channel[];
    guild: Guild | null;
    activeChannelId?: string | null;
    canCreate?: boolean;
    canManagePermissions?: boolean;
    canManageChannels?: boolean;
    ziehen: KanalZiehen;
    kontext: ZiehKontext;
    onSelect: (c: Channel) => void;
    onRename: (c: Channel) => void;
    onDelete: (c: Channel) => void;
    onReport: (c: Channel) => void;
  } = $props();
</script>

<!-- Abschnitts-Überschrift als dezentes Chip-Band (mobil) — Variante C des
     Rahmen-Entwurfs: keine Voll-Karten um die Zeilen (wirkte klotzig), nur
     die Sektionsgrenze bekommt eine leichte Fläche. Ab md unverändert offen. -->
<div
  class="text-text-muted mb-1.5 inline-block rounded-full border border-border bg-bg-input px-2.5 py-1 text-sm font-bold md:mb-0 md:rounded-none md:border-0 md:bg-transparent md:px-2.5 md:py-0 md:text-xs"
>
  {m.channel_list_text_channels()}
</div>
{#each channels as c (c.id)}
  {@const isUnread = activeChannelId !== c.id && readState.isUnread(c.id)}
  {@const unreadCount = activeChannelId !== c.id ? readState.getUnreadCount(c.id) : 0}
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props: ctxProps })}
        <ChannelTopicTooltip topic={c.topic}>
        {#snippet children(tipProps)}
        <button
          {...ctxProps}
          {...tipProps}
          class="{CHANNEL_BTN_CLASS} {ziehen.ueber === c.id
            ? 'border-t-2 border-primary'
            : ''} {ziehen.id === c.id ? 'opacity-50' : ''}"
          data-active={activeChannelId === c.id}
          data-unread={isUnread}
          onclick={() => onSelect(c)}
          draggable={canManageChannels}
          ondragstart={(e) => beginnen(e, c, ziehen, canManageChannels)}
          ondragover={(e) => darueber(e, c, ziehen, kontext.channels)}
          ondrop={(e) => void ablegen(e, c, ziehen, kontext)}
          ondragend={() => beenden(ziehen)}
          data-testid={`channel-${c.id}`}
        >
          <HashIcon class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary group-data-[unread=true]:text-text-bright" />
          <span class="truncate {isUnread ? 'font-semibold text-text-bright' : ''}" style={channelNameStyle(c)}>{c.name}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5">
            {#if c.restricted}
              <LockIcon
                class="text-text-muted size-4 md:size-3.5"
                data-testid={`channel-lock-${c.id}`}
                aria-label={m.channel_list_restricted()}
              />
            {/if}
            {#if unreadCount > 0}
              <span
                class="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-badge-count px-1 text-2xs font-bold leading-none text-white"
                data-testid="channel-mention-pill"
                data-unread-count={unreadCount}
                aria-label={m.channel_list_unread_mentions({ count: unreadCount })}
              >{unreadCount > 99 ? '99+' : unreadCount}</span>
            {:else if isUnread}
              <span
                class="size-2 shrink-0 rounded-full bg-badge-count"
                data-testid="channel-unread-dot"
                aria-label={m.channel_list_unread()}
              ></span>
            {/if}
          </span>
        </button>
        {/snippet}
        </ChannelTopicTooltip>
      {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Content>
      {#if canCreate}
        <ContextMenu.Item onSelect={() => onRename(c)} data-testid="channel-context-settings">
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
        onSelect={() => onReport(c)}
        data-testid={`channel-report-${c.id}`}
      >
        <FlagIcon />
        {m.channel_list_report()}
      </ContextMenu.Item>
      {#if canCreate}
        <ContextMenu.Separator />
        <ContextMenu.Item variant="destructive" onSelect={() => onDelete(c)}>
          <Trash2Icon />
          {m.channel_list_delete_channel()}
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
{/each}
{#if channels.length === 0}
  <p class="text-text-muted px-3 py-2 text-xs">{m.channel_list_no_text_channels()}</p>
{/if}
