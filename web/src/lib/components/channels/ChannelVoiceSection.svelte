<script lang="ts">
  /**
   * Die Sprachkanäle der Kanalliste samt Teilnehmern, Standplatz-Geräten,
   * Auto-Verbinden und dem räumlichen Klang-Steller.
   *
   * Aus `ChannelList.svelte` herausgelöst — siehe `ChannelTextSection.svelte`.
   * Der grösste der drei Abschnitte, weil an einer Sprachkanal-Zeile deutlich
   * mehr hängt als an einer Textkanal-Zeile: die Teilnehmerliste, fremde
   * Bildschirmströme, Watch-Partys und die Ablegefläche für Nutzer und Geräte.
   * Markup unverändert, `data-testid` identisch.
   */
  import * as ContextMenu from '$lib/components/ui/context-menu/index.js';
  import Volume2Icon from '@lucide/svelte/icons/volume-2';
  import LockIcon from '@lucide/svelte/icons/lock';
  import PencilIcon from '@lucide/svelte/icons/pencil';
  import ShieldIcon from '@lucide/svelte/icons/shield';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import ZapIcon from '@lucide/svelte/icons/zap';
  import ZapOffIcon from '@lucide/svelte/icons/zap-off';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import { goto } from '$app/navigation';
  import { voice } from '$lib/voice/livekit.svelte';
  import { voiceAutoConnect } from '$lib/voice/autoconnect.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { inVoiceChannel } from '$lib/voice/state.svelte';
  import { voicePresence } from '$lib/stores/voicePresence.svelte';
  import { chooseHqForUser } from '$lib/stream/hqTile';
  import { channelNameStyle } from '$lib/utils/nameColor';
  import { settings } from '$lib/stores/settings.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { CHANNEL_BTN_CLASS } from '$lib/channels/stil';
  import {
    KanalZiehen,
    beginnen,
    darueber,
    ablegen,
    beenden,
    sprachDarueber,
    sprachVerlassen,
    sprachAblegen,
    type ZiehKontext
  } from '$lib/channels/ziehen.svelte';
  import ChannelTopicTooltip from '../ChannelTopicTooltip.svelte';
  import VoiceChannelPresence from './VoiceChannelPresence.svelte';
  import DeviceChannelRows from '$lib/devices/components/DeviceChannelRows.svelte';
  import type { Device } from '$lib/api/devices';
  import type { Channel, Guild } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';

  let {
    channels,
    guild,
    myId,
    activeChannelId = null,
    canCreate = false,
    canManagePermissions = false,
    canManageChannels = false,
    activeDeviceId = null,
    onSelectDevice,
    ziehen,
    kontext,
    onSelect,
    onRename,
    onDelete,
    onReport
  }: {
    channels: Channel[];
    guild: Guild | null;
    myId: string | null;
    activeChannelId?: string | null;
    canCreate?: boolean;
    canManagePermissions?: boolean;
    canManageChannels?: boolean;
    activeDeviceId?: string | null;
    onSelectDevice?: (device: Device) => void;
    ziehen: KanalZiehen;
    kontext: ZiehKontext;
    onSelect: (c: Channel) => void;
    onRename: (c: Channel) => void;
    onDelete: (c: Channel) => void;
    onReport: (c: Channel) => void;
  } = $props();

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
</script>

{#if channels.length > 0}
  <div class="my-3 hairline bg-border" aria-hidden="true"></div>
  <div class="text-text-muted px-2.5 pb-1 text-sm font-bold md:text-xs">{m.channel_list_voice_channels()}</div>
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
            : ''} {ziehen.id === c.id ? 'opacity-50' : ''} {ziehen.nutzerUeber === c.id
            ? 'ring-2 ring-primary'
            : ''}"
          data-active={activeChannelId === c.id}
          onclick={() => onSelect(c)}
          draggable={canManageChannels}
          ondragstart={(e) => beginnen(e, c, ziehen, canManageChannels)}
          ondragover={(e) => sprachDarueber(e, c, ziehen, kontext)}
          ondragleave={(e) => sprachVerlassen(e, c, ziehen)}
          ondrop={(e) => void sprachAblegen(e, c, ziehen, kontext)}
          ondragend={() => beenden(ziehen)}
          data-testid={`channel-${c.id}`}
        >
          <Volume2Icon class="text-text-muted size-6 shrink-0 md:size-[17px] group-data-[active=true]:text-primary" />
          <span class="truncate" style={channelNameStyle(c)}>{c.name}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5">
            {#if c.user_limit && c.user_limit > 0}
              <span
                class="text-text-muted text-2xs tabular-nums md:text-2xs"
                title={m.channel_list_user_limit_title({ limit: c.user_limit })}
                data-testid={`channel-user-limit-${c.id}`}
              >{voicePresence.usersIn(c.id).length}/{c.user_limit}</span>
            {/if}
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
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title={m.channel_list_connected()}></span>
            {/if}
          </span>
        </button>
        {/snippet}
        </ChannelTopicTooltip>
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
      {#if !viewport.isMobile}
        <ContextMenu.CheckboxItem
          checked={settings.audio.spatialMode !== 'off'}
          onCheckedChange={(v) => {
            const mode = v ? 'high' : 'off';
            settings.setSpatialMode(mode);
            voice.setSpatialMode(mode);
          }}
          data-testid={`channel-spatial-${c.id}`}
        >
          {m.settings_audio_video_spatial_label()}
        </ContextMenu.CheckboxItem>
      {/if}
      {#if canCreate}
        <ContextMenu.Separator />
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
  <VoiceChannelPresence channel={c} {myId} {onSelect} />
  <!-- Standplatz-Geraete stehen UNTER ihrem Kanal, nicht in einer eigenen
       Kategorie (Aenderung 2026-08-16, Begruendung in DeviceChannelRows) —
       und unter ALLEN Menschen des Kanals, nicht ueber ihnen: die
       Teilnehmerliste ist die bewegliche Groesse (wer kommt, wer geht), die
       Geraete stehen fest. Als Schlusszeile bleiben sie an derselben
       Stelle, statt die Namen darunter bei jedem Beitritt zu verschieben.
       Ausserhalb des `members`-Blocks, denn ein Geraet steht auch in einem
       Kanal, in dem gerade niemand sitzt — genau der Regelfall bei einem
       unbeaufsichtigten Rechner. -->
  {#if guild && onSelectDevice}
    <DeviceChannelRows
      guildId={c.guild_id}
      channelId={c.id}
      {activeDeviceId}
      onSelect={onSelectDevice}
      onDragEnd={() => beenden(ziehen)}
      onWatch={(d) => {
        chooseHqForUser(c.id, d.owner_user_id);
        onSelect(c);
      }}
    />
  {/if}
{/each}
{:else}
  <p class="text-text-muted px-3 py-2 text-xs">{m.channel_list_no_voice_channels()}</p>
{/if}
