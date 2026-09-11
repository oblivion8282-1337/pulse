<script lang="ts">
  /**
   * Die Community-Dateiablage auf dem PULSE-Laufwerk (2026-09-11,
   * Spezifikation `docs/superpowers/specs/2026-09-11-pulse-laufwerk-design.md`).
   *
   * Drei Zustaende, ein Pfad, kein Zwischenlager und keine Festigung mehr:
   * verbinden (nur Besitzer, ein Klick — kein Link, kein OAuth), hochladen
   * (clientseitig verschluesselt per presigned PUT direkt auf den
   * Pulse-Objektspeicher), herunterladen, loeschen. Gelten tut dabei
   * durchgehend `DateiSpeicher` ueber den `pulse`-Adapter — dieselbe Engine
   * wie bei jedem anderen Laufwerk auch.
   *
   * **Offene Grenze (aus E8 uebernommen, unverändert):** wie ein
   * Nicht-Verbindungs-Geraet an den Ablage-Hauptschluessel kommt (Design
   * §3.1: Postfach — fuer Communitys noch nicht verdrahtet). Ein solches
   * Geraet sieht den Bereich im Zustand „verbunden, aber ohne Schluessel“
   * und bekommt das ehrlich gemeldet, statt Bytes zu verschicken.
   */
  import { groesseText } from '$lib/ablage/groesseText';
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
  import { ablagePulseApi } from '$lib/api/ablagePulse.ts';
  import { ablageVerbindungen } from '$lib/ablage/verbindungen.svelte.ts';
  import { bytesZuBase64 } from '$lib/ablage/syncOrdnerSchluessel.ts';
  import { sichererBlobTyp } from '$lib/krypto/sichererBlobTyp.ts';
  import type { AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import type { DateiInfo } from '$lib/ablage/dateispeicher.ts';

  let { guildId, istBesitzer }: { guildId: string; istBesitzer: boolean } = $props();

  let status: 'laedt' | 'nicht_verbunden' | 'ohne_schluessel' | 'verbunden' = $state('laedt');
  let zeilen: DateiInfo[] = $state([]);
  let genutzt = $state(0);
  let kontingent = $state(0);
  let laeuft = $state(false);
  let fehler = $state('');
  let dateiInput: HTMLInputElement | null = $state(null);

  async function frischeKontingent(): Promise<void> {
    const s = await ablagePulseApi.status(guildId);
    genutzt = s.genutzt_bytes;
    kontingent = s.kontingent_bytes;
  }

  async function ladeListe(): Promise<void> {
    const lokal = ablageVerbindungen.verbindungFürGuild(guildId);
    if (!lokal) {
      status = 'ohne_schluessel';
      return;
    }
    const speicher = await ablageVerbindungen.dateiSpeicherFür(lokal.id);
    if (!speicher) {
      status = 'ohne_schluessel';
      return;
    }
    zeilen = await speicher.liste();
  }

  async function pruefeStatus(): Promise<void> {
    const s = await ablagePulseApi.status(guildId);
    genutzt = s.genutzt_bytes;
    kontingent = s.kontingent_bytes;
    if (!s.verbunden) {
      status = 'nicht_verbunden';
      return;
    }
    status = 'verbunden';
    await ladeListe();
  }

  onMount(() => {
    void pruefeStatus();
  });

  /**
   * Verbindet das Pulse-Laufwerk — EIN Klick. Der Ablage-Hauptschluessel
   * entsteht hier lokal und verlaesst dieses Geraet nie (Konzept §3.1);
   * dem Server wird nur gemeldet, dass die Community ein Laufwerk hat.
   */
  async function verbindePulse(): Promise<void> {
    laeuft = true;
    fehler = '';
    try {
      await ablagePulseApi.verbinden(guildId);
      if (!ablageVerbindungen.verbindungFürGuild(guildId)) {
        const schluessel = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const verbindung: AblageVerbindung = {
          id: `pulse-${guildId}`,
          anbieter: 'pulse',
          name: 'Pulse-Laufwerk',
          konfiguration: {},
          hauptschlüsselB64: bytesZuBase64(schluessel),
          verbundenAm: new Date().toISOString()
        };
        await ablageVerbindungen.hinzufügen(verbindung);
        await ablageVerbindungen.verknüpfeMitGuild(verbindung.id, guildId);
      }
      await pruefeStatus();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  function speicherFuerVerbindung() {
    const lokal = ablageVerbindungen.verbindungFürGuild(guildId);
    if (!lokal) return null;
    return ablageVerbindungen.dateiSpeicherFür(lokal.id);
  }

  async function hochladen(dateien: FileList | null): Promise<void> {
    if (!dateien?.length) return;
    const speicher = await speicherFuerVerbindung();
    if (!speicher) {
      fehler = 'Dieses Gerät hat keinen Zugriffsschlüssel für dieses Laufwerk.';
      return;
    }
    laeuft = true;
    fehler = '';
    try {
      for (const datei of dateien) {
        const inhalt = new Uint8Array(await datei.arrayBuffer());
        await speicher.hochladen(
          datei.name,
          datei.type || 'application/octet-stream',
          inhalt,
          ''
        );
      }
      await ladeListe();
      await frischeKontingent();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
      if (fehler.includes('quota')) {
        fehler = 'Der Speicher dieser Community ist voll.';
      }
    } finally {
      laeuft = false;
      if (dateiInput) dateiInput.value = '';
    }
  }

  async function herunterladen(zeile: DateiInfo): Promise<void> {
    const speicher = await speicherFuerVerbindung();
    if (!speicher) return;
    try {
      const geöffnet = await speicher.herunterladen(zeile.id);
      const blob = new Blob([geöffnet.inhalt as unknown as BlobPart], {
        type: sichererBlobTyp(geöffnet.mime)
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = geöffnet.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
  }

  async function loeschen(zeile: DateiInfo): Promise<void> {
    const speicher = await speicherFuerVerbindung();
    if (!speicher) return;
    try {
      await speicher.löschen(zeile.id);
      await ladeListe();
      await frischeKontingent();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
  }
</script>

{#if status === 'laedt'}
  <!-- still: kein Flackern beim ersten Statusabruf -->
{:else if status === 'nicht_verbunden'}
  {#if istBesitzer}
    <div class="rounded-lg border border-dashed p-6 text-center" data-testid="community-ablage-aufforderung">
      <HardDriveIcon class="mx-auto mb-2 size-6 text-muted-foreground" />
      <p class="mb-3 text-sm text-muted-foreground">
        Kein Laufwerk verbunden. Das Pulse-Laufwerk ist verschlüsselter Speicher auf dem
        Pulse-Server — nur dieses Gerät und berechtigte Geräte halten den Schlüssel dazu.
      </p>
      <Button onclick={verbindePulse} disabled={laeuft} data-testid="community-ablage-verbinden">
        Pulse-Laufwerk verbinden
      </Button>
      {#if fehler}
        <p class="mt-2 text-sm text-destructive">{fehler}</p>
      {/if}
    </div>
  {/if}
{:else if status === 'ohne_schluessel'}
  <div class="rounded-lg border border-dashed p-6 text-center" data-testid="community-ablage-ohne-schluessel">
    <p class="text-sm text-muted-foreground">
      Für diese Community ist ein Pulse-Laufwerk verbunden, aber dieses Gerät hat keinen
      Zugriffsschlüssel dafür. Der Schlüssel liegt auf dem Gerät, das das Laufwerk verbunden hat.
    </p>
  </div>
{:else}
  <div class="space-y-3" data-testid="community-ablage-ansicht">
    {#if fehler}
      <p class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {fehler}
      </p>
    {/if}
    <div class="min-h-[80px] rounded-lg border p-2">
      {#each zeilen as zeile (zeile.id)}
        <div class="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted" data-testid="community-ablage-datei-{zeile.id}">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium">{zeile.name}</div>
            <div class="text-xs text-muted-foreground">{groesseText(zeile.groesse)}</div>
          </div>
          <button
            class="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Herunterladen"
            onclick={() => herunterladen(zeile)}
          >
            <DownloadIcon class="size-4" />
          </button>
          <button
            class="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
            title="Löschen"
            onclick={() => loeschen(zeile)}
          >
            <Trash2Icon class="size-4" />
          </button>
        </div>
      {/each}
      {#if zeilen.length === 0}
        <p class="px-3 py-4 text-center text-sm text-muted-foreground">Noch keine Dateien.</p>
      {/if}
    </div>
    <div class="flex items-center justify-between">
      <input
        type="file"
        multiple
        class="hidden"
        bind:this={dateiInput}
        onchange={(e) => hochladen((e.target as HTMLInputElement).files)}
      />
      <Button variant="secondary" size="sm" disabled={laeuft} onclick={() => dateiInput?.click()} data-testid="community-ablage-hochladen">
        <UploadIcon class="mr-1 size-4" />
        Hochladen
      </Button>
      <span class="text-xs text-muted-foreground" data-testid="community-ablage-kontingent">
        {groesseText(genutzt)} von {groesseText(kontingent)} belegt
      </span>
    </div>
  </div>
{/if}
