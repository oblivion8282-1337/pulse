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

  Der Knopf heisst „Übernehmen" und tut seit 2026-08-16 beides:
  wecken → warten, bis das Bild da ist → eigenes Player-Fenster → Fernsteuerung
  anfordern. Die Reihenfolge bleibt getrennt (die Anfrage geht erst nach dem
  Bild hinaus, s. `schirme.svelte.ts::uebernehmen`), aber sie kostet keinen
  zweiten Klick mehr: bei einem Standplatz-Gerät ist die Zustimmung als
  Dauerfreigabe längst erteilt, ein „Fernsteuerung anfragen" fragte also etwas
  bereits Beantwortetes. Der Knopf an der Kachel bleibt als „Beenden" und als
  Rückweg, wenn die Anfrage doch einmal ins Leere lief.
-->
<script lang="ts">
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import PlayIcon from '@lucide/svelte/icons/play';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import EyeIcon from '@lucide/svelte/icons/eye';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { Device, DeviceMonitor } from '$lib/api/devices';
  import { schirmWarten, schirmeVon, zusehen } from '$lib/devices/schirme.svelte';
  import { gegenstelle } from '$lib/remote/gegenstelle';
  import { userCache } from '$lib/stores/users.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { darfFernsteuern } from '$lib/remote/darfSteuern';
  import { m } from '$lib/paraglide/messages.js';

  let {
    device,
    onOpenChannel,
  }: {
    device: Device;
    /** Zum Standplatz wechseln, sobald das Bild da ist. */
    onOpenChannel: (channelId: string) => void;
  } = $props();

  const steuernder = $derived(device.busy_with ? gegenstelle(device.busy_with) : null);

  $effect(() => {
    // Nur noch fuer den Steuernden: Besitzer und Standplatz stehen seit
    // 2026-08-18 nicht mehr in dieser Ansicht (die Kopfzeile daneben nennt
    // beides ohnehin).
    if (device.busy_with) userCache.queue(device.busy_with);
  });

  const schirme = $derived(schirmeVon(device));
  const laeuft = $derived(schirme.some((s) => s.open));
  const wartetAuf = $derived(schirmWarten.wartetAuf(device.id));
  const fehler = $derived(schirmWarten.fehler[device.id] ?? null);
  // **Das eigene Gerät wird nicht angeboten** (Bughunt 2026-08-16). „Übernehmen"
  // hiesse hier: den Rechner fernsteuern, an dem man gerade sitzt. Die Anfrage
  // sprang bisher still in `darfFernsteuern` zurück — der Knopf tat also
  // scheinbar nichts, und schlimmer: der Weckruf war da schon hinaus, der
  // Rechner übertrug. Verglichen wird gegen die Kennung auf DIESEM Server, denn
  // `owner_user_id` ist eine serverlokale (auf einem Self-Host ist die
  // Cloud-Kennung eine andere).
  const eigenes = $derived(currentServerUserId() === device.owner_user_id);
  // Und ohne `REMOTE_CONTROL` ebenfalls kein Weckruf: die Anfrage danach spränge
  // still zurück, der Rechner bliebe aber wach und übertrüge — genau die Lage,
  // gegen die es die Nachlauf-Wache in `wecken.ts` braucht. Zweimal geprüft ist
  // hier billiger als einmal zu spät.
  const steuerbar = $derived(darfFernsteuern(device.channel_id, device.owner_user_id));
  /**
   * Für DIESEN Betrachter bleibt nur Zusehen.
   *
   * Drei verschiedene Gründe, eine Folge: der eigene Rechner (man kann sein
   * eigenes Konto nicht fernsteuern), kein `REMOTE_CONTROL`, oder ein anderer
   * steuert bereits. In allen dreien darf das Bild trotzdem offenstehen — es
   * liegt ohnehin für jeden im Kanal.
   */
  const nurZusehen = $derived(eigenes || !steuerbar || device.state === 'busy');

  // Sobald das erwartete Bild da ist: Fenster öffnen und hinwechseln. Die
  // Entscheidung selbst liegt im gemeinsamen Modul — sie muss auch dann
  // laufen, wenn die Anforderung aus dem Player-Fenster kam und diese Ansicht
  // gar nicht offen ist (`RemoteControllerInput` prüft dort mit).
  $effect(() => {
    if (schirmWarten.einloesen(device)) onOpenChannel(device.channel_id);
  });

</script>

<!-- Die Klassen der Fläche sind DIESELBEN wie bei den Geschwistern, die an
     dieser Stelle stehen (`VoiceChannelView`, die Gesperrt- und Leer-Ansichten
     in der Kanalseite) — die Geräteansicht ersetzt die Kanalansicht und muss
     sich deshalb wie eine verhalten.

     Bis 2026-08-18 fehlten hier `glass-panel` und `flex-1`, und beides fiel
     sofort auf: ohne `flex-1` wächst der Block nicht auf die Breite des
     Hauptbereichs, sondern bleibt auf Inhaltsbreite stehen und klebt am linken
     Rand; ohne `glass-panel` fehlt die Fläche, auf der jede andere Ansicht
     sitzt. Wer hier etwas ändert, gleicht mit den Geschwistern ab. -->
<div
  class="glass-panel relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-none p-8 md:rounded-2xl"
  data-testid="device-view"
>
  <!-- **Der Weg zurück** (2026-08-19). Die Ansicht ersetzt die Kanalansicht im
       ganzen Hauptbereich, hatte aber keinen Ausgang: der Klick auf den Kanal,
       IN dem das Gerät steht, kürzte in `selectChannel` als „schon da" ab (das
       Gerät steht in der Adresse, nicht der Kanal), und einen Zurück-Knopf gab
       es nicht. Wer ein Gerät einmal geöffnet hatte, kam nur über einen anderen
       Kanal oder den Zurück-Knopf des Browsers wieder heraus — im Electron-
       Fenster also gar nicht. Der Knopf sitzt in der Ecke statt in der Mitte:
       die Mitte gehört dem Übernehmen. -->
  <Button
    variant="ghost"
    size="sm"
    class="text-text-muted absolute left-3 top-3 gap-1.5"
    onclick={() => onOpenChannel(device.channel_id)}
    data-testid="device-view-back"
  >
    <ArrowLeftIcon class="size-4" />
    {m.device_view_back_to_channel()}
  </Button>

  <div class="flex flex-col items-center gap-3 text-center">
    <span class="border-text-muted/40 text-text-muted grid size-16 place-items-center rounded-xl border">
      <MonitorIcon class="size-8" />
    </span>
    <h1 class="text-text-bright font-mono text-2xl">{device.name}</h1>
  </div>

  {#if device.state === 'busy'}
    <p class="text-sm text-amber-500" data-testid="device-view-busy">
      {m.device_view_busy_with({ user: steuernder?.anzeige ?? '' })}
    </p>
  {/if}

  <!-- **Zusehen ist der leisere der beiden Wege** und hat eigene Regeln: es
       braucht nur das Recht, den Kanal zu sehen. Deshalb steht die Liste der
       LAUFENDEN Bildschirme hier oben, vor allen Fällen, in denen Übernehmen
       ausfällt — beim eigenen Gerät (man sitzt davor, will es aber vom Laptop
       aus im Blick haben), ohne `REMOTE_CONTROL`, und während ein anderer
       steuert. Bis 2026-08-16 zeigte die Ansicht in genau diesen drei Fällen
       gar nichts, obwohl das Bild im Kanal für jeden offen lag. -->
  {#if nurZusehen && laeuft}
    <div class="flex flex-col items-center gap-2" data-testid="device-view-watch">
      <span class="text-text-muted text-xs">{m.device_view_screens()}</span>
      <div class="flex flex-wrap justify-center gap-2">
        {#each schirme.filter((s) => s.open) as mon (mon.index)}
          <Button
            size="sm"
            variant="outline"
            onclick={() => zusehen(device, mon)}
            data-testid={`device-view-watch-${mon.index}`}
          >
            <EyeIcon class="size-4" />
            {mon.name}
          </Button>
        {/each}
      </div>
    </div>
  {/if}

  {#if device.state === 'busy'}
    <!-- Der Rest der Ansicht gehört dem Übernehmen — und das ist vergeben. -->
  {:else if eigenes}
    <!-- Der eigene Rechner: kein Knopf. Absichtlich ohne Meldung — „dir fehlt
         das Recht" wäre gelogen, und dass man vor dem Ding sitzt, sieht man. -->
  {:else if !steuerbar}
    <p class="text-text-muted max-w-sm text-center text-sm" data-testid="device-view-denied">
      {m.device_view_no_permission()}
    </p>
  {:else if !laeuft}
    <!-- Noch nichts läuft: ein Knopf, und der holt den Bildschirm, den das
         Gerät selbst dafür vorsieht — deshalb `ausdruecklich: false`. -->
    {@const haupt = schirme.find((s) => s.primary) ?? schirme[0]}
    <!-- **Offline heisst wirklich unerreichbar** — es gibt kein Wake-on-LAN, der
         Rechner muss laufen und bei Pulse angemeldet sein. Ohne dieses
         `disabled` liess sich der Knopf drücken, der Weckruf ging an ein Gerät
         ohne Verbindung, und nach dem Zeitablauf kam „Das Gerät hat nicht
         geantwortet." Ein Knopf, der sichtbar nichts bewirken kann, gehört
         ausgegraut statt in eine Wartezeit zu führen. -->
    <Button
      size="lg"
      onclick={() => schirmWarten.holen(device, haupt, false)}
      disabled={!!wartetAuf || device.state === 'offline'}
      data-testid="device-view-take-over"
    >
      <PlayIcon class="size-4" />
      {wartetAuf ? m.device_view_waking() : m.device_view_wake()}
    </Button>
    {#if device.state === 'offline'}
      <!-- Nur der Befund, nicht die Anleitung: der Knopf darueber ist bereits
           ausgegraut, und ein ausgegrauter Knopf ohne jedes Wort liesse offen,
           ob die App klemmt. Was zu tun ist (einschalten, anmelden), stand hier
           frueher dazu und war fuer den taeglichen Blick zu viel Text. -->
      <p class="text-text-muted text-xs" data-testid="device-view-offline">
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
            disabled={schirmWarten.wartetAufSchirm(device.id, mon.index)}
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
