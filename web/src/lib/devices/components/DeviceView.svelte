<!--
  DeviceView — ein Gerät im Hauptbereich, wie ein Kanal.

  **Kein Popover** (Entwurf §5): man ist dann BEIM Gerät, und die Kopfzeile sagt
  das auch. Ein Aufklapper, den man wieder wegklickt, wäre die falsche Form für
  etwas, das man gleich übernimmt.

  Der Knopf macht aus zwei Vorgängen einen Klick, ohne sie zu vermischen:
  wecken → warten, bis das Bild da ist → Kachel öffnen. Die Fernsteuer-Anfrage
  selbst bleibt der unveränderte, bestehende Weg an der Kachel — sie ist die
  Stelle, an der die Zustimmung fällt (oder die Dauerfreigabe antwortet), und
  die gehört nicht in einen Automatismus.

  **Warum nicht gleich mit anfragen** (§8): dann hinge eine Sitzungszusage an
  einer Encoder-Initialisierung. Scheitert die, stünde eine aktive Sitzung ohne
  Bild da, und der Fehler wäre nicht lesbar.
-->
<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import PlayIcon from '@lucide/svelte/icons/play';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { Device } from '$lib/api/devices';
  import { geraetWecken } from '$lib/devices/wecken';
  import { streamPresence } from '$lib/stores/streamPresence.svelte';
  import { chooseHqForUser } from '$lib/stream/hqTile';
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

  let laeuft = $state(false);
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

  // Läuft die Übertragung des Geräts? Der Besitzer ist der Streamer — das Gerät
  // meldet sich mit dessen Konto an (Stufe 1 des Standplatz-Plans).
  const uebertraegt = $derived(
    streamPresence.streamersIn(device.channel_id).includes(device.owner_user_id),
  );

  // Sobald das Bild da ist: Kachel öffnen und hinwechseln. Als Effect statt im
  // Klick-Handler, weil das Bild asynchron erscheint — der Klick weiss noch
  // nicht, wann.
  $effect(() => {
    if (!laeuft || !uebertraegt) return;
    laeuft = false;
    if (wecker) clearTimeout(wecker);
    wecker = null;
    chooseHqForUser(device.channel_id, device.owner_user_id, device.name);
    onOpenChannel(device.channel_id);
  });

  $effect(() => () => {
    if (wecker) clearTimeout(wecker);
  });

  function uebernehmen(): void {
    fehler = null;
    // Läuft die Übertragung schon, ist der Weckruf trotzdem harmlos: das Gerät
    // verwirft ihn (`wecken.ts`). Das spart hier eine Sonderbehandlung, deren
    // Bedingung („läuft schon") auf zwei Rechnern verschieden alt wäre.
    if (!geraetWecken(activeServer.serverId, device.id)) {
      fehler = m.device_view_wake_failed();
      return;
    }
    laeuft = true;
    if (wecker) clearTimeout(wecker);
    wecker = setTimeout(() => {
      laeuft = false;
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
  {:else}
    <Button size="lg" onclick={uebernehmen} disabled={laeuft} data-testid="device-view-take-over">
      <PlayIcon class="size-4" />
      {laeuft
        ? m.device_view_waking()
        : uebertraegt
          ? m.device_view_take_over()
          : m.device_view_wake()}
    </Button>
    {#if device.state === 'offline'}
      <p class="text-text-muted max-w-sm text-center text-xs">
        {m.device_view_offline_hint()}
      </p>
    {/if}
  {/if}

  {#if fehler}
    <p class="text-sm text-red-500" data-testid="device-view-error">{fehler}</p>
  {/if}
</div>
