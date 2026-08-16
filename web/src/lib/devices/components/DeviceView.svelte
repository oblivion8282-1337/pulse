<!--
  DeviceView — ein Gerät im Hauptbereich, wie ein Kanal.

  **Kein Popover** (Entwurf §5): man ist dann BEIM Gerät, und die Kopfzeile sagt
  das auch. Ein Aufklapper, den man wieder wegklickt, wäre die falsche Form für
  etwas, das man gleich übernimmt.

  ## Mehrere Bildschirme

  Wie bei Parsec: der erste Klick holt den **Hauptbildschirm**, die weiteren
  Schirme schaltet man hier einzeln dazu. Jeder wird **erst beim Anfordern**
  übertragen — ein Bildschirm, den niemand sehen will, kostet weder Rechenzeit
  auf dem fernen Gerät noch Bandbreite. Jeder dazugeschaltete Schirm wird eine
  eigene Kachel und damit ein eigenes Player-Fenster; die Eingabe folgt dem
  Fenster, in dem die Maus gerade ist, denn der Drahtvertrag trägt die
  Platznummer in jeder Nachricht.

  Der Knopf macht aus zwei Vorgängen einen Klick, ohne sie zu vermischen:
  wecken → warten, bis das Bild da ist → Kachel öffnen. Die Fernsteuer-Anfrage
  bleibt der unveränderte, bestehende Weg an der Kachel — sie ist die Stelle, an
  der die Zustimmung fällt (oder die Dauerfreigabe antwortet), und die gehört
  nicht in einen Automatismus.
-->
<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import PlayIcon from '@lucide/svelte/icons/play';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { Device, DeviceMonitor } from '$lib/api/devices';
  import { geraetWecken } from '$lib/devices/wecken';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { openedTiles } from '$lib/stream/openedTiles.svelte';
  import { hqTileId } from '$lib/stream/hqTile';
  import { gegenstelle } from '$lib/remote/gegenstelle';
  import { userCache } from '$lib/stores/users.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    device,
    onOpenChannel,
  }: {
    device: Device;
    /** Zum Standplatz wechseln, sobald das Bild da ist. */
    onOpenChannel: (channelId: string) => void;
  } = $props();

  /** Wie lange auf das erste Bild gewartet wird.
   *
   *  Grosszügig: der Rechner muss den Encoder hochfahren, und auf einer
   *  ausgelasteten Maschine dauert das. Zu kurz gewählt hiesse, dass die
   *  Oberfläche „hat nicht geantwortet" sagt, während der Stream gerade
   *  anläuft — der schlechteste Zeitpunkt für eine Absage. */
  const WARTEN_MS = 25_000;

  /** Auf welchen Bildschirm gerade gewartet wird (`null` = auf keinen). */
  let wartetAuf = $state<DeviceMonitor | null>(null);
  let fehler = $state<string | null>(null);
  let wecker: ReturnType<typeof setTimeout> | null = null;

  const besitzer = $derived(gegenstelle(device.owner_user_id));
  const kanal = $derived(
    guilds.channelsByGuild[device.guild_id]?.find((c) => c.id === device.channel_id) ?? null,
  );
  const steuernder = $derived(device.busy_with ? gegenstelle(device.busy_with) : null);

  $effect(() => {
    userCache.queue(device.owner_user_id);
    if (device.busy_with) userCache.queue(device.busy_with);
  });

  /**
   * Die Bildschirme, die angeboten werden.
   *
   * Meldet das Gerät keine (nie verbunden oder ältere Fassung), bleibt genau
   * ein Eintrag übrig: sein Hauptbildschirm. Das ist ehrlicher als eine
   * erfundene Liste — und der eine Knopf tut, was er immer getan hat.
   */
  const schirme = $derived<DeviceMonitor[]>(
    device.monitors.length > 0
      ? device.monitors
      : [{ index: 0, name: m.device_view_screen_primary(), primary: true }],
  );

  /** Die laufenden Übertragungen dieses Geräts (der Besitzer ist der Streamer). */
  const stroeme = $derived(
    streamPresence.streamsIn(device.channel_id).filter((s) => s.user_id === device.owner_user_id),
  );

  /** Der Strom, der diesen Bildschirm zeigt — erkannt am Namen, den das Gerät
   *  beim Start mitgeschickt hat (`stream/starten.ts` nimmt ihn aus der wirklich
   *  aufgenommenen Quelle). `undefined` = dieser Schirm läuft noch nicht. */
  function stromFuer(mon: DeviceMonitor) {
    return stroeme.find((s) => s.label === mon.name || s.label === `Monitor ${mon.index}`);
  }

  const laeuft = $derived(stroeme.length > 0);

  // Sobald das erwartete Bild da ist: Kachel öffnen und hinwechseln. Als Effect
  // statt im Klick-Handler, weil das Bild asynchron erscheint — der Klick weiss
  // noch nicht, wann.
  $effect(() => {
    const ziel = wartetAuf;
    if (!ziel) return;
    const strom = stromFuer(ziel) ?? (stroeme.length > 0 ? stroeme[0] : undefined);
    if (!strom) return;
    wartetAuf = null;
    if (wecker) clearTimeout(wecker);
    wecker = null;
    openedTiles.open('hq', device.channel_id, hqTileId(device.owner_user_id, strom.slot));
    onOpenChannel(device.channel_id);
  });

  $effect(() => () => {
    if (wecker) clearTimeout(wecker);
  });

  function holen(mon: DeviceMonitor): void {
    fehler = null;
    const offen = stromFuer(mon);
    if (offen) {
      // Läuft schon: nur die Kachel holen, keinen zweiten Weckruf. Der wäre
      // zwar harmlos (das Gerät verwirft ihn), aber der Umweg über „warten"
      // liesse den Knopf ohne Grund eine Sekunde lang beschäftigt aussehen.
      openedTiles.open('hq', device.channel_id, hqTileId(device.owner_user_id, offen.slot));
      onOpenChannel(device.channel_id);
      return;
    }
    // `index: 0` ist der Ersatz-Eintrag ohne Bildschirmliste — dann ohne
    // Nummer wecken, und das Gerät nimmt seinen Hauptbildschirm.
    if (!geraetWecken(activeServer.serverId, device.id, mon.index || undefined)) {
      fehler = m.device_view_wake_failed();
      return;
    }
    wartetAuf = mon;
    if (wecker) clearTimeout(wecker);
    wecker = setTimeout(() => {
      wartetAuf = null;
      fehler = m.device_view_wake_failed();
    }, WARTEN_MS);
  }
</script>

<div class="flex h-full flex-col items-center justify-center gap-6 p-8" data-testid="device-view">
  <div class="flex flex-col items-center gap-3 text-center">
    <span class="border-text-muted/40 text-text-muted grid size-16 place-items-center rounded-xl border">
      <MonitorIcon class="size-8" />
    </span>
    <h1 class="text-text-bright font-mono text-2xl">{device.name}</h1>
    <p class="text-text-muted text-sm">
      {m.device_view_owner({ user: besitzer.anzeige })}
      {#if kanal}
        · {m.device_view_place({ channel: kanal.name })}
      {/if}
    </p>
    <p class="text-text-muted max-w-md text-xs">{m.device_view_intro()}</p>
  </div>

  {#if device.state === 'busy'}
    <p class="text-sm text-amber-500" data-testid="device-view-busy">
      {m.device_view_busy_with({ user: steuernder?.anzeige ?? '' })}
    </p>
  {:else if !laeuft}
    <!-- Noch nichts läuft: ein Knopf, und der holt den Hauptbildschirm. -->
    {@const haupt = schirme.find((s) => s.primary) ?? schirme[0]}
    <Button
      size="lg"
      onclick={() => holen(haupt)}
      disabled={!!wartetAuf}
      data-testid="device-view-take-over"
    >
      <PlayIcon class="size-4" />
      {wartetAuf ? m.device_view_waking() : m.device_view_wake()}
    </Button>
    {#if device.state === 'offline'}
      <p class="text-text-muted max-w-sm text-center text-xs">
        {m.device_view_offline_hint()}
      </p>
    {/if}
  {:else}
    <!-- Läuft schon: je Bildschirm ein Eintrag. Offene führen zur Kachel,
         geschlossene werden erst beim Klick übertragen. -->
    <div class="flex flex-col items-center gap-2" data-testid="device-view-screens">
      <span class="text-text-muted text-xs">{m.device_view_screens()}</span>
      <div class="flex flex-wrap justify-center gap-2">
        {#each schirme as mon (mon.index)}
          {@const offen = !!stromFuer(mon)}
          <Button
            size="sm"
            variant={offen ? 'default' : 'outline'}
            onclick={() => holen(mon)}
            disabled={wartetAuf?.index === mon.index}
            data-testid={`device-view-screen-${mon.index}`}
          >
            {#if !offen}
              <PlusIcon class="size-4" />
            {/if}
            {mon.name}
          </Button>
        {/each}
      </div>
      <span class="text-text-muted max-w-sm text-center text-xs">
        {m.device_view_screens_hint()}
      </span>
    </div>
  {/if}

  {#if fehler}
    <p class="text-sm text-red-500" data-testid="device-view-error">{fehler}</p>
  {/if}
</div>
