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
  import { schirmWarten, schirmeVon } from '$lib/devices/schirme.svelte';
  import { gegenstelle } from '$lib/remote/gegenstelle';
  import { userCache } from '$lib/stores/users.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    device,
    onOpenChannel,
  }: {
    device: Device;
    /** Zum Standplatz wechseln, sobald das Bild da ist. */
    onOpenChannel: (channelId: string) => void;
  } = $props();

  const besitzer = $derived(gegenstelle(device.owner_user_id));
  const kanal = $derived(
    guilds.channelsByGuild[device.guild_id]?.find((c) => c.id === device.channel_id) ?? null,
  );
  const steuernder = $derived(device.busy_with ? gegenstelle(device.busy_with) : null);

  $effect(() => {
    userCache.queue(device.owner_user_id);
    if (device.busy_with) userCache.queue(device.busy_with);
  });

  const schirme = $derived(schirmeVon(device));
  const laeuft = $derived(schirme.some((s) => s.open));
  const wartetAuf = $derived(schirmWarten.wartetAuf(device.id));
  const fehler = $derived(schirmWarten.fehler[device.id] ?? null);

  // Sobald das erwartete Bild da ist: Fenster öffnen und hinwechseln. Die
  // Entscheidung selbst liegt im gemeinsamen Modul — sie muss auch dann
  // laufen, wenn die Anforderung aus dem Player-Fenster kam und diese Ansicht
  // gar nicht offen ist (`RemoteControllerInput` prüft dort mit).
  $effect(() => {
    if (schirmWarten.einloesen(device)) onOpenChannel(device.channel_id);
  });

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
      onclick={() => schirmWarten.holen(device, haupt)}
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
          {@const offen = mon.open}
          <Button
            size="sm"
            variant={offen ? 'default' : 'outline'}
            onclick={() => schirmWarten.holen(device, mon)}
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
