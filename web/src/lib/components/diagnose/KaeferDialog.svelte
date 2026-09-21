<!--
  Käfer-Knopf-Dialog: Diagnose-Bericht an die Pulse-Cloud (Spec 2026-09-21 §5).

  Drei Regeln aus dem Spec, hier umgesetzt:
  1. Einwilligung durch die Handlung — der Klick auf „Senden" ist die
     Einwilligung; deshalb funktioniert der Weg auch im Browser, wo der
     Auto-Send-Schalter des Streaming-Berichts nie existieren konnte.
  2. Vorschau vor dem Versand — der Nutzer sieht, WAS gesendet wird
     (Kopf + verdichtete Ereignisse), bevor er bestätigt.
  3. Fallback — scheitert der Versand (ausgerechnet „Cloud nicht erreichbar"
     ist denkbar), gibt es den Bericht als Datei zum klassischen Schicken.

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
    leseRingpuffer,
    bericht,
    leeren,
    darfJetztSenden,
    merkeUebertragung,
    speichereAlsDatei
  } from '$lib/diagnose/app-diagnose';
  import type { AppBericht } from '$lib/diagnose/app-diagnose';

  let open = $derived(uiOverlays.diagnoseOpen);

  let notiz = $state('');
  let busy = $state(false);
  let gesendet = $state(false);
  let fehler = $state<string | null>(null);
  let dateiOfferiert = $state(false);
  let vorschau = $state<AppBericht | null>(null);

  // Kopf beim Öffnen bauen — Serverliste/UA holen wir hier (mit Stores), damit
  // das Gedächtnis-Modul selbst importfrei bleiben kann.
  function baueVorschau(): void {
    vorschau = bericht(
      {
        app: 'pulse-web',
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        kerne: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
        server: serversStore.servers.map((s) => ({
          name: s.server_name ?? s.label,
          hostname: s.hostname,
          cloud: s.isCloud
        })),
        aktiver_server:
          serversStore.find(activeServer.serverId)?.hostname ?? CLOUD_HOSTNAME ?? null,
        erstellt: new Date().toISOString()
      },
      notiz.trim()
    );
  }

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      // Frisches Öffnen: Zustand zurücksetzen, Vorschau aus dem Puffer bauen.
      gesendet = false;
      fehler = null;
      dateiOfferiert = false;
      baueVorschau();
    }
    wasOpen = open;
  });

  function handleOpenChange(next: boolean): void {
    if (!next) {
      notiz = '';
      gesendet = false;
      fehler = null;
      dateiOfferiert = false;
      uiOverlays.diagnoseOpen = false;
    }
  }

  async function senden(): Promise<void> {
    if (!vorschau || busy) return;
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
      const ziel =
        window.location.origin === CLOUD_HOSTNAME
          ? '/api/auth/experimental-logs'
          : `${CLOUD_HOSTNAME}/api/auth/experimental-logs`;
      const resp = await fetch(ziel, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          reason: 'user_report',
          role: 'app',
          system_info: vorschau.kopf,
          report: vorschau
        })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Erfolg: Drossel merken, Puffer leeren (dieselben Ereignisse nicht
      // doppelt schicken), Dialog schließen.
      merkeUebertragung();
      leeren();
      gesendet = true;
      setTimeout(() => uiOverlays.diagnoseOpen = false, 1200);
    } catch {
      fehler = m.diagnose_senden_fehler();
      dateiOfferiert = true;
    } finally {
      busy = false;
    }
  }

  function alsDatei(): void {
    if (!vorschau) return;
    speichereAlsDatei(bericht(vorschau.kopf, notiz.trim()));
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
              {#each letzteEreignisse as e (e.s)}
                <li class="font-mono">
                  t+{e.s}s · {e.art}{e.anzahl > 1 ? ` ×${e.anzahl}` : ''}
                </li>
              {/each}
            </ul>
          {/if}
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
