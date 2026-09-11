<script lang="ts">
  /**
   * Die Community-Dateiablage auf dem PULSE-Laufwerk (2026-09-11,
   * Spezifikation `docs/superpowers/specs/2026-09-11-pulse-laufwerk-design.md`,
   * Festlegungen nach Abstimmung s. Spec §11).
   *
   * Ein Pfad, kein Zwischenlager und keine Festigung: verbinden (nur
   * Besitzer, über den gewohnten Verbinden-Dialog — darin für Communitys
   * genau ein Anbieter, das Pulse-Laufwerk), hochladen (clientseitig
   * verschlüsselt per presigned PUT direkt auf den Pulse-Objektspeicher),
   * herunterladen, löschen. Gelten tut dabei durchgehend `DateiSpeicher`
   * über den `pulse`-Adapter — dieselbe Engine wie bei jedem anderen
   * Laufwerk auch.
   *
   * Das GEWAND ist das der alten Dropbox-Ablage (Glass-Panel, Quota-Gauge,
   * Toolbar mit Upload/Suche/Raster-Listen-Umschalter, Datei-Karten) — die
   * Chrome-Bausteine `DropboxQuotaGauge` und das Karten-/Zeilen-Aussehen
   * sind übernommen. Was die verschlüsselte Ablage (Stand: flaches
   * Verzeichnis) bewusst NICHT hat: Ordner, Papierkorb, Anheften, Umbenennen,
   * Verschieben — Nachrüstung möglich, sobald das Verzeichnis Pfade trägt.
   *
   * **Offene Grenze (aus E8 übernommen, unverändert):** wie ein
   * Nicht-Verbindungs-Gerät an den Ablage-Hauptschlüssel kommt (Design
   * §3.1: Postfach — für Communitys noch nicht verdrahtet). Ein solches
   * Gerät sieht den Bereich im Zustand „verbunden, aber ohne Schlüssel“
   * und bekommt das ehrlich gemeldet, statt Bytes zu verschicken.
   */
  import { onMount } from 'svelte';
  import type { Component } from 'svelte';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
  import Rows3Icon from '@lucide/svelte/icons/rows-3';
  import FileIcon from '@lucide/svelte/icons/file';
  import ImageIcon from '@lucide/svelte/icons/image';
  import VideoIcon from '@lucide/svelte/icons/video';
  import MusicIcon from '@lucide/svelte/icons/music';
  import ArchiveIcon from '@lucide/svelte/icons/archive';
  import { ablagePulseApi } from '$lib/api/ablagePulse.ts';
  import { ablageVerbindungen } from '$lib/ablage/verbindungen.svelte.ts';
  import { sichererBlobTyp } from '$lib/krypto/sichererBlobTyp.ts';
  import { formatBytes } from '$lib/utils/formatBytes';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import DropboxQuotaGauge from '../dropbox/DropboxQuotaGauge.svelte';
  import AblageVerbindenDialog from './AblageVerbindenDialog.svelte';
  import { communityAnbieter } from '$lib/ablage/anbieter.ts';
  import type { DateiInfo } from '$lib/ablage/dateispeicher.ts';

  let { guildId, istBesitzer }: { guildId: string; istBesitzer: boolean } = $props();

  let status: 'laedt' | 'nicht_verbunden' | 'ohne_schluessel' | 'verbunden' = $state('laedt');
  let zeilen: DateiInfo[] = $state([]);
  let genutzt = $state(0);
  let kontingent = $state(0);
  let laeuft = $state(false);
  let fehler = $state('');
  let dateiInput: HTMLInputElement | null = $state(null);
  let verbindenOffen = $state(false);
  let suchText = $state('');
  let istRaster = $state(true);

  let gefiltert = $derived(
    suchText.trim() === ''
      ? zeilen
      : zeilen.filter((z) => z.name.toLowerCase().includes(suchText.trim().toLowerCase()))
  );

  /** Gleiche Icon-Logik wie die alte Dropbox-Ablage — nur lokal, ohne
   *  DropboxEntry-Typ zu brauchen. */
  function dateiIcon(mime: string): Component {
    const t = (mime || '').toLowerCase();
    if (t.startsWith('image/')) return ImageIcon;
    if (t.startsWith('video/')) return VideoIcon;
    if (t.startsWith('audio/')) return MusicIcon;
    if (t.includes('zip') || t.includes('compressed') || t.includes('tar')) return ArchiveIcon;
    return FileIcon;
  }

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

  /** Einheitliche Icon-Knopf-Optik — übernommen aus der alten
   *  Dropbox-Toolbar, damit sich die Ablage identisch anfühlt. */
  const ICON_BTN =
    'flex items-center justify-center rounded-md border border-border/40 bg-bg-hover/40 p-2 text-text-muted hover:bg-bg-hover hover:text-text-base disabled:opacity-40';
  const ICON_BTN_ACTIVE =
    'flex items-center justify-center rounded-md border border-primary/40 bg-primary/10 p-2 text-primary hover:bg-primary/15';
</script>

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col rounded-none md:rounded-2xl"
  data-testid="community-ablage-ansicht"
>
  {#if status === 'laedt'}
    <p class="text-text-faint py-12 text-center text-sm">Wird geladen …</p>
  {:else if status === 'nicht_verbunden'}
    {#if istBesitzer}
      <div class="flex flex-1 items-center justify-center p-8">
        <div
          class="rounded-lg border border-dashed p-6 text-center"
          data-testid="community-ablage-aufforderung"
        >
          <p class="mb-3 text-sm text-muted-foreground">
            Noch kein Laufwerk verbunden. Verbinde eines, damit Mitglieder Dateien
            ablegen können.
          </p>
          <Button
            onclick={() => (verbindenOffen = true)}
            data-testid="community-ablage-verbinden"
          >
            Laufwerk verbinden
          </Button>
          {#if fehler}
            <p class="mt-2 text-sm text-destructive">{fehler}</p>
          {/if}
        </div>
      </div>
    {:else}
      <p class="text-text-faint py-12 text-center text-sm">
        Noch keine Ablage eingerichtet.
      </p>
    {/if}
  {:else if status === 'ohne_schluessel'}
    <div
      class="flex flex-1 items-center justify-center p-8"
      data-testid="community-ablage-ohne-schluessel"
    >
      <p class="max-w-md text-center text-sm text-muted-foreground">
        Für diese Community ist ein Pulse-Laufwerk verbunden, aber dieses Gerät hat
        keinen Zugriffsschlüssel dafür. Der Schlüssel liegt auf dem Gerät, das das
        Laufwerk verbunden hat.
      </p>
    </div>
  {:else}
    <DropboxQuotaGauge
      quota={{ enabled: true, used_bytes: genutzt, total_quota_bytes: kontingent } as never}
    />

    <div class="flex flex-wrap items-center gap-2 border-b border-border/40 px-5 py-2.5">
      <button
        type="button"
        class={ICON_BTN}
        onclick={() => dateiInput?.click()}
        disabled={laeuft}
        title="Hochladen"
        aria-label="Hochladen"
        data-testid="community-ablage-hochladen"
      >
        <UploadIcon class="size-4" />
      </button>
      <Input
        type="text"
        placeholder="Dateien suchen"
        aria-label="Dateien suchen"
        class="flex-1"
        value={suchText}
        oninput={(e) => (suchText = (e.currentTarget as HTMLInputElement).value)}
        data-testid="community-ablage-suche"
      />
      <button
        type="button"
        class={istRaster ? ICON_BTN_ACTIVE : ICON_BTN}
        onclick={() => (istRaster = !istRaster)}
        title="Ansicht umschalten"
        aria-label="Ansicht umschalten"
        data-testid="community-ablage-ansicht-umschalten"
      >
        {#if istRaster}
          <Rows3Icon class="size-4" />
        {:else}
          <LayoutGridIcon class="size-4" />
        {/if}
      </button>
    </div>

    {#if fehler}
      <p
        class="mx-5 mt-3 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {fehler}
      </p>
    {/if}

    <div class="flex-1 overflow-y-auto px-5 py-4">
      {#if gefiltert.length === 0}
        <div class="text-text-faint py-12 text-center text-sm">
          {#if suchText.trim() !== ''}
            Keine Treffer für „{suchText}“.
          {:else}
            Noch keine Dateien.
          {/if}
        </div>
      {:else if istRaster}
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {#each gefiltert as zeile (zeile.id)}
            {@const Icon = dateiIcon(zeile.mime)}
            <div
              class="glass-2 group relative flex flex-col gap-1.5 rounded-xl border-2 border-border/60 p-3 transition-colors hover:border-primary/60"
              data-testid="community-ablage-datei-{zeile.id}"
            >
              <div
                class="flex aspect-square w-full items-center justify-center rounded-md bg-bg-hover/40 text-text-dim group-hover:bg-primary/5"
              >
                <Icon class="size-12" />
              </div>
              <p class="truncate text-sm font-medium" title={zeile.name}>{zeile.name}</p>
              <p class="text-text-faint text-xs">{formatBytes(zeile.groesse)}</p>
              <div
                class="absolute right-1 top-1 flex gap-0.5 opacity-0 transition group-hover:opacity-100"
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Herunterladen"
                  onclick={() => herunterladen(zeile)}
                  data-testid="community-ablage-download-{zeile.id}"
                >
                  <DownloadIcon class="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Löschen"
                  onclick={() => loeschen(zeile)}
                >
                  <Trash2Icon class="size-3.5" />
                </Button>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="space-y-1">
          {#each gefiltert as zeile (zeile.id)}
            {@const Icon = dateiIcon(zeile.mime)}
            <div
              class="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted"
              data-testid="community-ablage-datei-{zeile.id}"
            >
              <Icon class="size-5 shrink-0 text-text-dim" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium" title={zeile.name}>
                  {zeile.name}
                </div>
                <div class="text-text-faint text-xs">
                  {formatBytes(zeile.groesse)}
                  {#if zeile.hochgeladenAm}
                    · {new Date(zeile.hochgeladenAm).toLocaleDateString()}
                  {/if}
                </div>
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
        </div>
      {/if}
    </div>
  {/if}

  <input
    type="file"
    multiple
    class="hidden"
    bind:this={dateiInput}
    onchange={(e) => hochladen((e.target as HTMLInputElement).files)}
  />
</section>

{#if verbindenOffen}
  <AblageVerbindenDialog
    open
    anbieterListe={communityAnbieter()}
    {guildId}
    onClose={() => (verbindenOffen = false)}
    onVerbunden={() => {
      fehler = '';
      void pruefeStatus();
    }}
  />
{/if}
