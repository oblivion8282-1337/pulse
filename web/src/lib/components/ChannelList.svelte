<script lang="ts">
import { errText } from '$lib/utils/errText';
  /**
   * Die Kanalliste einer Community.
   *
   * **War bis zum Mobil-Umbau 819 Zeilen** — über der harten Grenze von 500
   * (`PLAN.md` §12.1) — und ist jetzt der blosse Zusammensetzer: Kopfzeile,
   * die drei Abschnitte, die Dialoge, die Fusszeile. Die Zeilen selbst leben
   * in `channels/`, weil der Handy-Umbau sie an drei Stellen braucht
   * (Vollbild-Liste, Kanal-Wechsler-Sheet, Tablet-Spalte).
   *
   * Der Schnitt ist rein strukturell: `data-testid`, Klassen und Reihenfolge
   * sind unverändert. Bricht danach ein Test, ist der Code kaputt, nicht der
   * Test.
   */
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { toast } from 'svelte-sonner';
  import { voice } from '$lib/voice/livekit.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { roles } from '$lib/stores/roles.svelte';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { messages } from '$lib/stores/messages.svelte';
  import { gateway } from '$lib/ws/connection';
  import { chatApi } from '$lib/api/chat';
  import { Perm } from '$lib/permissions/bitfield';
  import type { ZiehKontext } from '$lib/channels/ziehen.svelte';
  import type { Channel, Guild } from '$lib/api/types';
  import type { Device } from '$lib/api/devices';
  import { m } from '$lib/paraglide/messages.js';
  import RenameChannelDialog from './RenameChannelDialog.svelte';
  import ReportMessageDialog from './chat/ReportMessageDialog.svelte';
  import DeviceUmzugDialog from '$lib/devices/components/DeviceUmzugDialog.svelte';
  import SidebarFooter from './SidebarFooter.svelte';
  import ChannelListHeader from './channels/ChannelListHeader.svelte';
  import ChannelSections from './channels/ChannelSections.svelte';

  let {
    guild,
    channels,
    activeChannelId = null,
    onSelect,
    onCreateClick,
    onChannelDeleted,
    canCreate = false,
    activeDeviceId = null,
    onSelectDevice,
    onBack,
    variant = 'aside'
  }: {
    guild: Guild | null;
    channels: Channel[];
    activeChannelId?: string | null;
    onSelect: (c: Channel) => void;
    onCreateClick: () => void;
    onChannelDeleted?: (channelId: string) => void;
    canCreate?: boolean;
    /** Gerade geoeffnetes Standplatz-Geraet (fuer die Hervorhebung). */
    activeDeviceId?: string | null;
    /** Ein Geraet wurde angeklickt. Ohne Rueckruf bleibt die Kategorie
     *  unsichtbar — eine Liste, die auf nichts fuehrt, ist keine. */
    onSelectDevice?: (device: Device) => void;
    /** Zurueck zur Community-Uebersicht — nur auf Handy/Tablet gesetzt. */
    onBack?: () => void;
    /** `aside` = eigenstaendige Spalte (Rechner, Vollbild-Liste des Handys).
     *  `sheet` = Inhalt eines Blattes von unten: ohne Panel-Rahmen und ohne
     *  Nutzer-Fusszeile, denn das Blatt bringt seinen eigenen Rahmen mit und
     *  die Fusszeile gehoert nicht in einen Kanal-Wechsler. Alles andere —
     *  Dialoge, Kontextmenues, Zeilen — ist in beiden Faellen dasselbe; genau
     *  deshalb ist es eine Ausprägung und keine zweite Komponente. */
    variant?: 'aside' | 'sheet';
  } = $props();

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
  // Per-guild dropbox / Ablage channel (type===2). One-per-guild by
  // construction, but filtered as a list so the section renders nothing at
  // all when the feature is off for this community.
  let dropboxChannels = $derived(
    guild?.dropbox_allowed
      ? channels.filter((c) => c.type === 2).sort((a, b) => a.position - b.position)
      : []
  );

  let canManagePermissions = $derived(
    !!guild && roles.hasGuildPermission(guild.id, Perm.MANAGE_ROLES)
  );
  let canManageChannels = $derived(
    !!guild && roles.hasGuildPermission(guild.id, Perm.MANAGE_CHANNELS)
  );

  // Invite button visibility — anyone with CREATE_INVITES (owner gets it
  // implicitly via the resolver's GRANT_ALL_SAFE short-circuit). The
  // server-wide allow_member_invites toggle stays the secondary gate
  // mirroring routes/invites.py.
  const canInvite = $derived(
    !!guild &&
      roles.hasGuildPermission(guild.id, Perm.CREATE_INVITES) &&
      (myId === guild.owner_id || capabilities.allowMemberInvites)
  );

  // Discord-style: clicking a voice channel joins it. connect() must run from
  // this user gesture so the browser allows the AudioContext to start.
  // Clicking a dropbox channel is a normal navigate — DropboxView mounts
  // on the channel route like ChatView, no side effects to schedule.
  function selectChannel(c: Channel) {
    if (c.type === 1 && voice.channelId !== c.id) {
      voice.connect(c.id, c.name).catch((e) => {
        toast.error(m.channel_list_voice_connect_failed(), {
          description: errText(e)
        });
      });
    }
    onSelect(c);
  }

  // Was das Ziehen zum Ablegen wissen muss. Als Derived, damit die Listen
  // darin nie veralten — ein gemerkter Verweis zeigte auf die Reihenfolge von
  // vor dem letzten Umsortieren.
  let ziehKontext = $derived<ZiehKontext>({
    guild,
    channels,
    textChannels,
    voiceChannels,
    myId,
    auswaehlen: selectChannel
  });

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

<svelte:element
  this={variant === 'sheet' ? 'div' : 'aside'}
  class={variant === 'sheet'
    ? 'text-text-base flex min-h-0 w-full flex-col'
    : 'glass-panel text-text-base flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none md:w-60 md:flex-none md:rounded-2xl lg:w-68'}
  data-testid="channel-list"
>
  <ChannelListHeader {guild} {canInvite} {canCreate} {onCreateClick} {onBack} />

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

  <!-- Einmal für die ganze Liste, nicht je Kanalzeile: es kann immer nur EIN
       Gerät gezogen werden, und der Dialog gehört zum Zug, nicht zum Ziel. -->
  <DeviceUmzugDialog />

  <nav class="flex-1 overflow-y-auto px-2.5 pb-3 pt-3">
    <ChannelSections
      {guild}
      {textChannels}
      {dropboxChannels}
      {voiceChannels}
      kontext={ziehKontext}
      {myId}
      {activeChannelId}
      {canCreate}
      {canManagePermissions}
      {canManageChannels}
      {activeDeviceId}
      {onSelectDevice}
      onSelect={selectChannel}
      onRename={(c) => (renameChannel = c)}
      onDelete={openDelete}
      onReport={(c) => (reportChannel = c)}
    />
  </nav>

  {#if variant === 'aside'}
    <SidebarFooter />
  {/if}
</svelte:element>
