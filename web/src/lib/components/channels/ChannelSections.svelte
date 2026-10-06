<script lang="ts">
  /**
   * Die drei Kanal-Abschnitte einer Community — Text, Ablage, Sprache — als
   * ein Baustein.
   *
   * **Das ist das Stück, das der Mobil-Umbau an drei Stellen braucht:** als
   * Vollbild-Liste unter `/app/rooms/[guildId]`, im Kanal-Wechsler-Sheet und
   * als mittlere Spalte auf dem Tablet. Vorher steckte es unteilbar in
   * `ChannelList.svelte` (819 Zeilen); wer es wiederverwenden wollte, hätte
   * die Zeilen abschreiben müssen, und drei Abschriften laufen auseinander.
   *
   * Der Rahmen drumherum (Kopfzeile, Dialoge, Fusszeile) gehört bewusst NICHT
   * hierher: das Sheet hat keine Fusszeile, die Tablet-Spalte keinen eigenen
   * Kopf. Was aussen liegt, entscheidet der Aufrufer.
   */
  import { KanalZiehen, type ZiehKontext } from '$lib/channels/ziehen.svelte';
  import ChannelTextSection from './ChannelTextSection.svelte';
  import ChannelDropboxSection from './ChannelDropboxSection.svelte';
  import ChannelVoiceSection from './ChannelVoiceSection.svelte';
  import type { Device } from '$lib/api/devices';
  import type { Channel, Guild } from '$lib/api/types';

  let {
    guild,
    textChannels,
    dropboxChannels,
    voiceChannels,
    kontext,
    myId,
    activeChannelId = null,
    canCreate = false,
    canManagePermissions = false,
    canManageChannels = false,
    activeDeviceId = null,
    onSelectDevice,
    onSelect,
    onRename,
    onDelete,
    onReport
  }: {
    guild: Guild | null;
    textChannels: Channel[];
    dropboxChannels: Channel[];
    voiceChannels: Channel[];
    kontext: ZiehKontext;
    myId: string | null;
    activeChannelId?: string | null;
    canCreate?: boolean;
    canManagePermissions?: boolean;
    canManageChannels?: boolean;
    activeDeviceId?: string | null;
    onSelectDevice?: (device: Device) => void;
    onSelect: (c: Channel) => void;
    onRename: (c: Channel) => void;
    onDelete: (c: Channel) => void;
    onReport: (c: Channel) => void;
  } = $props();

  // Eine Zieh-Instanz je Liste, von allen drei Abschnitten geteilt: es kann
  // immer nur EIN Kanal gleichzeitig gezogen werden, und die Einfüge-Linie
  // darf nicht in zwei Abschnitten gleichzeitig stehen.
  const ziehen = new KanalZiehen();
</script>

<ChannelTextSection
  channels={textChannels}
  {guild}
  {activeChannelId}
  {canCreate}
  {canManagePermissions}
  {canManageChannels}
  {ziehen}
  {kontext}
  {onSelect}
  {onRename}
  {onDelete}
  {onReport}
/>

<ChannelDropboxSection
  channels={dropboxChannels}
  {activeChannelId}
  {canCreate}
  {canManageChannels}
  {ziehen}
  {kontext}
  {onSelect}
  {onRename}
  {onDelete}
  {onReport}
/>

<ChannelVoiceSection
  channels={voiceChannels}
  {guild}
  {myId}
  {activeChannelId}
  {canCreate}
  {canManagePermissions}
  {canManageChannels}
  {activeDeviceId}
  {onSelectDevice}
  {ziehen}
  {kontext}
  {onSelect}
  {onRename}
  {onDelete}
  {onReport}
/>
