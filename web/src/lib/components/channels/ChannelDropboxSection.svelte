<script lang="ts">
  /**
   * Der Ablage-Kanal einer Community (Typ 2), falls es einen gibt.
   *
   * Aus `ChannelList.svelte` herausgelöst — siehe `ChannelTextSection.svelte`
   * für die Begründung. Markup unverändert, `data-testid` identisch.
   */
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import LockIcon from '@lucide/svelte/icons/lock';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import FlagIcon from '@lucide/svelte/icons/flag';
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
  import type { Channel } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channels,
    activeChannelId = null,
    canCreate = false,
    canManageChannels = false,
    ziehen,
    kontext,
    onSelect,
    onRename,
    onDelete,
    onReport
  }: {
    channels: Channel[];
    activeChannelId?: string | null;
    canCreate?: boolean;
    canManageChannels?: boolean;
    ziehen: KanalZiehen;
    kontext: ZiehKontext;
    onSelect: (c: Channel) => void;
    onRename: (c: Channel) => void;
    onDelete: (c: Channel) => void;
    onReport: (c: Channel) => void;
  } = $props();
</script>

{#if channels.length > 0}
  <div class="my-3 hairline bg-border" aria-hidden="true"></div>
  <div
    class="text-text-muted mb-1.5 inline-block rounded-full border border-border bg-bg-input px-2.5 py-1 text-sm font-bold md:mb-0 md:rounded-none md:border-0 md:bg-transparent md:px-2.5 md:py-0 md:text-xs"
  >
    {m.channel_list_dropbox_section()}
  </div>
  {#each channels as c (c.id)}
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
            onclick={() => onSelect(c)}
            draggable={canManageChannels}
            ondragstart={(e) => beginnen(e, c, ziehen, canManageChannels)}
            ondragover={(e) => darueber(e, c, ziehen, kontext.channels)}
            ondrop={(e) => void ablegen(e, c, ziehen, kontext)}
            ondragend={() => beenden(ziehen)}
            data-testid={`channel-${c.id}`}
          >
            <FolderIcon class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary" />
            <span class="truncate" style={channelNameStyle(c)}>{c.name}</span>
            <span class="ml-auto flex shrink-0 items-center gap-1.5">
              {#if c.restricted}
                <LockIcon
                  class="text-text-muted size-4 md:size-3.5"
                  data-testid={`channel-lock-${c.id}`}
                  aria-label={m.channel_list_restricted()}
                />
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
{/if}
