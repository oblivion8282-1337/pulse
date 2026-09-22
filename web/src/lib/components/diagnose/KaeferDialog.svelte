<!--
  Käfer-Knopf-Dialog: Diagnose-Bericht an die Pulse-Cloud (Spec 2026-09-21 §5).

  Drei Regeln aus dem Spec, hier umgesetzt:
  1. Einwilligung durch die Handlung — der Klick auf „Senden" ist die
     Einwilligung; deshalb funktioniert der Weg auch im Browser, wo der
     Auto-Send-Schalter des Streaming-Berichts nie existieren konnte.
  2. Vorschau vor dem Versand — der Nutzer sieht, WAS gesendet wird
     (Kopf mit Serverliste + verdichtete Ereignisse), bevor er bestätigt.
  3. Fallback — scheitert der Versand (ausgerechnet „Cloud nicht erreichbar"
     ist denkbar), gibt es den Bericht als Datei zum klassischen Schicken.

  Versand-Details, die der Bughunt 2026-09-21 nachgezogen hat: der Bericht
  wird erst BEIM Klick gebaut (die Freitext-Notiz und während des Dialogs
  neu ankommende Ereignisse gehören rein), `leeren()` löscht nur bis zum
  Sendezeitpunkt (nichts, was während des Fetch ankam, geht verloren) und
  `keepalive` ist bewusst NICHT gesetzt — Chromium lehnt keepalive-Bodies
  über ~64 KiB ab, ausgerechnet die inhaltreichsten Berichte würden also
  nie ankommen; die Seite bleibt beim nutzer-initiierten Versand ohnehin
  offen.

  Gesendet wird NUR der Ringpuffer + Freitext: keine Nachrichteninhalte,
  keine Tokens (s. Spec §8). Server-IDs werden beim Anzeigen zu Namen
  aufgelöst, gesendet wird die ID — die Zuordnung kennt die Cloud ohnehin.
-->
<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { BugIcon, DownloadIcon, SendIcon } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { serversStore, CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import { activeServer } from '$lib/stores/active-server.svelte';
  import {
    bericht,
    darfJetztSenden,
    leeren,
    merkeUebertragung,
    speichereAlsDatei
  } from '$lib/diagnose/app-diagnose';
  import type { AppBericht } from '$lib/diagnose/app-diagnose';
  import {
    stream as streamZustand,
    streamForSlot,
    runningStreamSlots
  } from '$lib/stream/state.svelte';
  import { hqStreams } from '$lib/stream/hqStreamManager.svelte';

  let open = $derived(uiOverlays.diagnoseOpen);

  // `notiz` überlebt Öffnen/Schließen bewusst (Draft-Verhalten): nach einem
  // FEHLGESCHLAGENEN Versand soll der getippte Text beim Wiederöffnen noch
  // da sein. Gelöscht wird er nur nach erfolgreichem Versand.
  let notiz = $state('');
  let busy = $state(false);
  let gesendet = $state(false);
  let fehler = $state<string | null>(null);
  let dateiOfferiert = $state(false);
  let vorschau = $state<AppBericht | null>(null);
  let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Stream-Momentaufnahme für den Berichtskopf (2026-09-22): WAS lief beim
   *  Klick — Sendungen dieses Rechners (Zustand/FPS/Laufzeit/Fehler) und die
   *  offenen Zuschau-Kacheln mit ihren Live-Zahlen. Schließt die Lücke, dass
   *  der Käfer die Streaming-Welt nicht sah (die automatischen Berichte des
   *  Experimental-Schalters gehen nur bei Stream-ENDE, nicht auf Klick).
   *  Alles schon Erhobene — kein neuer Sammel-Motor. */
  function streamKontext(): Record<string, unknown> {
    const sendungen = runningStreamSlots().map((slot) => {
      const s = streamForSlot(slot);
      return {
        slot,
        zustand: s.state,
        fps: s.fps,
        laufzeit_s: s.uptimeS,
        fehler: s.error ? s.error.slice(0, 120) : null
      };
    });
    const zuschauer = hqStreams.liste().map((ms) => ({
      kanal: ms.channelId,
      sender: ms.userId,
      slot: ms.slot,
      phase: ms.phase,
      ruht_im_eigenen_fenster: ms.ruhend,
      stats: ms.stats
        ? {
            aufloesung: ms.stats.res,
            fps: ms.stats.fps,
            bitrate: ms.stats.bitrate,
            codec: ms.stats.codec,
            eingefroren_seit_s: ms.stats.freezeSeconds,
            mikro_ruckler_gesamt: ms.stats.microStutters,
            frames_dekodiert: ms.stats.diagnostic.framesDecoded,
            frames_verworfen: ms.stats.diagnostic.framesDropped,
            pakete_verloren: ms.stats.diagnostic.packetsLost
          }
        : null
    }));
    return {
      sidecar_verfuegbar: streamZustand.sidecarAvailable,
      sendungen,
      zuschauer_kacheln: zuschauer
    };
  }

  // Kopf beim Öffnen bauen — Serverliste/UA holen wir hier (mit Stores), damit
  // das Gedächtnis-Modul selbst importfrei bleiben kann.
  function baueVorschau(): void {
    vorschau = bericht(
      {
        app: 'pulse-web',
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        kerne: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
        server: serversStore.servers.map((s) => ({
          hostname: s.hostname,
          cloud: s.isCloud
        })),
        aktiver_server:
          serversStore.find(activeServer.serverId)?.hostname ?? CLOUD_HOSTNAME ?? null,
        stream: streamKontext(),
        erstellt: new Date().toISOString()
      },
      notiz.trim()
    );
  }

  function stopAutoClose(): void {
    if (autoCloseTimer !== null) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  }

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      // Frisches Öffnen: Zustand zurücksetzen (inkl. eines pendenten
      // Auto-Close-Timers aus der VORSCHAU-Sitzung — ohne Stop schlösse der
      // alten Timer den frisch geöffneten Dialog unter der Hand).
      stopAutoClose();
      gesendet = false;
      fehler = null;
      dateiOfferiert = false;
      baueVorschau();
    }
    wasOpen = open;
  });

  function handleOpenChange(next: boolean): void {
    if (!next) {
      stopAutoClose();
      gesendet = false;
      fehler = null;
      dateiOfferiert = false;
      uiOverlays.diagnoseOpen = false;
    }
  }

  async function senden(): Promise<void> {
    if (busy || !vorschau) return;
    if (!darfJetztSenden()) {
      fehler = m.diagnose_drossel();
      return;
    }
    busy = true;
    fehler = null;
    try {
      // Bewusst CLOUD-absolut (Spec: „die gehen an die Pulse-Cloud“): wer die
      // App-Oberfläche von einem Self-Host-Origin aus offen hat, würde mit einer
      // relativen URL den Bericht in die Datenbank SEINES Servers legen — dort
      // sieht ihn der Super-Admin nie. Scheitert das an CORS (Origin nicht
      // freigegeben), greift der Datei-Fallback unten.
      // AUSNAHME Dev-Stack (2026-09-22, `import.meta.env.DEV` = Vite-Dev-
      // Server, im Prod-Build konstant false): der echte Cloud-Versand wäre
      // CORS-blockt (Prod-Allowlist ohne localhost) und die ganze Schleife
      // wäre untestbar — im Dev geht der Bericht deshalb an den LOKALEN
      // Stack (Vite-Proxy → auth :8001), landet in der Dev-Datenbank und ist
      // in der Admin-Ansicht „Diagnose“ begutachtbar.
      const ziel =
        window.location.origin === CLOUD_HOSTNAME || import.meta.env.DEV
          ? '/api/auth/experimental-logs'
          : `${CLOUD_HOSTNAME}/api/auth/experimental-logs`;
      // Nicht die Öffnen-Vorschau posten: Notiz + während des Dialogs neu
      // angekommene Ereignisse gehören in den Versand (Bughunt P1).
      const versand = bericht(vorschau.kopf, notiz.trim());
      // Sendezeitpunkt VOR dem Fetch merken: `leeren(bisTs)` löscht nach dem
      // Erfolg nur bis hierher — während des Fetch neu angekommenes bleibt.
      const sentAt = Date.now();
      const resp = await fetch(ziel, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: 'user_report',
          role: 'app',
          system_info: versand.kopf,
          report: versand
        })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      merkeUebertragung();
      leeren(sentAt);
      notiz = '';
      gesendet = true;
      autoCloseTimer = setTimeout(() => {
        autoCloseTimer = null;
        uiOverlays.diagnoseOpen = false;
      }, 1200);
    } catch {
      fehler = m.diagnose_senden_fehler();
      dateiOfferiert = true;
    } finally {
      busy = false;
    }
  }

  function alsDatei(): void {
    if (!vorschau) return;
    speichereAlsDatei(vorschau, 'pulse-diagnose');
  }

  const letzteEreignisse = $derived(vorschau ? vorschau.ereignisse.slice(-10).reverse() : []);
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content data-testid="diagnose-dialog" class="max-h-[85vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <BugIcon class="size-5" />
        {m.diagnose_titel()}
      </Dialog.Title>
      <Dialog.Description>{m.diagnose_beschreibung()}</Dialog.Description>
    </Dialog.Header>

    {#if gesendet}
      <Alert.Root>
        <SendIcon />
        <Alert.Description data-testid="diagnose-gesendet">{m.diagnose_gesendet()}</Alert.Description>
      </Alert.Root>
    {:else}
      <div class="space-y-4">
        <div>
          <label for="diagnose-notiz" class="text-text-bright mb-1 block text-sm font-semibold">
            {m.diagnose_notiz_label()}
          </label>
          <textarea
            id="diagnose-notiz"
            bind:value={notiz}
            maxlength={2000}
            rows={3}
            placeholder={m.diagnose_notiz_placeholder()}
            class="border-border bg-bg-hover text-text-base focus:border-primary w-full rounded-xl border px-3 py-2 text-sm outline-none"
            data-testid="diagnose-notiz"
          ></textarea>
        </div>

        <details class="border-border rounded-xl border px-3 py-2" data-testid="diagnose-vorschau">
          <summary class="text-text-muted cursor-pointer text-xs font-semibold">
            {m.diagnose_vorschau({ count: vorschau?.ereignisse.length ?? 0 })}
          </summary>
          {#if letzteEreignisse.length === 0}
            <p class="text-text-muted mt-2 text-xs">{m.diagnose_leer()}</p>
          {:else}
            <ul class="text-text-muted mt-2 space-y-1 text-xs">
              {#each letzteEreignisse as e, i (`${e.s}-${i}`)}
                <li class="font-mono">
                  t+{e.s}s · {e.art}{e.anzahl > 1 ? ` ×${e.anzahl}` : ''}
                </li>
              {/each}
            </ul>
          {/if}
          <details class="mt-2">
            <summary class="text-text-muted cursor-pointer text-xs">
              {m.diagnose_kopf_details()}
            </summary>
            <pre class="text-text-muted mt-1 overflow-x-auto text-2xs">{JSON.stringify(
              vorschau?.kopf,
              null,
              2
            )}</pre>
          </details>
        </details>

        {#if fehler}
          <Alert.Root variant="destructive">
            <Alert.Description data-testid="diagnose-fehler">{fehler}</Alert.Description>
          </Alert.Root>
        {/if}

        <Dialog.Footer>
          {#if dateiOfferiert}
            <Button variant="ghost" onclick={alsDatei} data-testid="diagnose-als-datei">
              <DownloadIcon class="size-4" />
              {m.diagnose_als_datei()}
            </Button>
          {/if}
          <Button onclick={senden} disabled={busy} data-testid="diagnose-senden">
            <SendIcon class="size-4" />
            {busy ? m.diagnose_senden_laeuft() : m.diagnose_senden()}
          </Button>
        </Dialog.Footer>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
