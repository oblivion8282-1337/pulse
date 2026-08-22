<script lang="ts">
  /**
   * Der Kanal-Wechsler: fährt von unten herein und zeigt alle Kanäle der
   * offenen Community.
   *
   * **Ersetzt den seitlichen Drawer auf Handy und Tablet.** Der Drawer kam vom
   * linken Bildschirmrand — genau dort, wo Android und iOS ihre Zurück-Geste
   * haben. Ein Blatt von unten kollidiert mit nichts und liegt ausserdem in
   * Daumenreichweite.
   *
   * **Der Inhalt ist die echte `ChannelList`**, nur in der Ausprägung `sheet`
   * (ohne Panel-Rahmen und ohne Nutzer-Fusszeile). Damit bringt der Wechsler
   * Kontextmenüs, Umbenennen, Löschen, Melden, Sprach-Teilnehmer und
   * Standplatz-Geräte unverändert mit — eine nachgebaute Kurzfassung hätte
   * das alles stillschweigend verloren.
   *
   * Masse aus dem bestehenden `MessageActionSheet.svelte` (Scrim `black/50`,
   * Griff-Strich, `--safe-bottom`), Eckenradius 22 px nach dem Entwurf.
   */
  import ChannelList from '$lib/components/ChannelList.svelte';
  import type { Channel, Guild } from '$lib/api/types';
  import type { Device } from '$lib/api/devices';
  import { m } from '$lib/paraglide/messages.js';

  let {
    open = $bindable(false),
    guild,
    channels,
    activeChannelId = null,
    canCreate = false,
    activeDeviceId = null,
    onSelectDevice,
    onSelect,
    onCreateClick,
    onChannelDeleted
  }: {
    open?: boolean;
    guild: Guild | null;
    channels: Channel[];
    activeChannelId?: string | null;
    canCreate?: boolean;
    activeDeviceId?: string | null;
    onSelectDevice?: (device: Device) => void;
    onSelect: (c: Channel) => void;
    onCreateClick: () => void;
    onChannelDeleted?: (channelId: string) => void;
  } = $props();

  function schliessen() {
    open = false;
  }

  // Ein Kanal-Tipp führt weiter UND schliesst das Blatt — ein Wechsler, der
  // nach der Wahl offen bleibt, verdeckt genau das, wohin man wollte.
  function waehlen(c: Channel) {
    onSelect(c);
    schliessen();
  }
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex flex-col justify-end" data-testid="channel-switcher-sheet">
    <button
      type="button"
      class="absolute inset-0 bg-black/50"
      aria-label={m.channel_switcher_close()}
      onclick={schliessen}
    ></button>
    <div
      class="bg-popover text-popover-foreground border-border relative flex max-h-[80dvh] flex-col overflow-y-auto rounded-t-[22px] border-t pb-[var(--safe-bottom)] shadow-2xl"
    >
      <div class="bg-border mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full"></div>
      <ChannelList
        variant="sheet"
        {guild}
        {channels}
        {activeChannelId}
        {canCreate}
        {activeDeviceId}
        onSelectDevice={(d) => {
          onSelectDevice?.(d);
          schliessen();
        }}
        onSelect={waehlen}
        {onCreateClick}
        {onChannelDeleted}
      />
    </div>
  </div>
{/if}
