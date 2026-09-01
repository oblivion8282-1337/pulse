<script lang="ts">
  /**
   * Die Community-Dateiablage — Etappe E8, Aufgabe 4. Schliesst
   * `DateiablageAnsicht.svelte` NICHT direkt an: deren Prop ist ein fertiger
   * `DateiSpeicher`, diese Ansicht muss aber zusaetzlich Zwischenlager-
   * Eintraege einblenden, die kein `DateiSpeicher.liste()` kennt — daher
   * dieselbe Optik (`sichererBlobTyp`, Symbole/Groessentexte) auf einer
   * zusammengefuehrten Liste.
   *
   * Drei Zustaende (serverseitig, `ablageGuildApi.laufwerkStatus`): kein
   * Laufwerk + Besitzer -> Aufforderung; kein Laufwerk + Mitglied -> nichts;
   * verbunden -> Liste aus Laufwerk (nur wenn DIESES Geraet den Ablage-
   * Hauptschluessel lokal hat, s. `festigung.ts`) + Zwischenlager (immer,
   * jedes Mitglied) als „noch nicht gesichert".
   *
   * **Offene Grenze, nicht Teil dieses Auftrags:** wie ein Nicht-Besitzer-
   * Geraet an den Hauptschluessel kommt (Design §3.1: Postfach — fuer
   * Communities noch nicht verdrahtet). Ohne ihn bleiben Hoch-/Herunterladen
   * auf diesem Geraet aus, mit Meldung statt Absturz.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import ClockIcon from '@lucide/svelte/icons/clock';
  import { ablageGuildApi, type ZwischenlagerEintrag } from '$lib/api/ablageGuild.ts';
  import { ablageVerbindungen } from '$lib/ablage/verbindungen.svelte.ts';
  import { packeDateiContainer, öffneDateiContainer } from '$lib/ablage/dateiablage.ts';
  import { base64ZuBytes } from '$lib/ablage/syncOrdnerSchluessel.ts';
  import { starteFestigungsSchleife } from '$lib/ablage/festigung.ts';
  import { sichererBlobTyp } from '$lib/krypto/sichererBlobTyp.ts';
  import NextcloudVerbinden from './NextcloudVerbinden.svelte';
  import type { AblageVerbindung } from '$lib/ablage/verbindungen.svelte.ts';
  import type { DateiInfo } from '$lib/ablage/dateispeicher.ts';

  let { guildId, istBesitzer }: { guildId: string; istBesitzer: boolean } = $props();

  type Zeile = DateiInfo & { ausstehend: boolean };

  let status: 'laedt' | 'nicht_verbunden' | 'verbunden' = $state('laedt');
  let verbindenOffen = $state(false);
  let zeilen: Zeile[] = $state([]);
  let laeuft = $state(false);
  let fehler = $state('');
  let dateiInput: HTMLInputElement | null = $state(null);
  let stoppeFestigung: (() => void) | null = null;

  function groesseText(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function ladeListe(): Promise<void> {
    const zwischenlager = await ablageGuildApi.zwischenlagerListe(guildId);
    const ausZwischenlager: Zeile[] = zwischenlager.map((e: ZwischenlagerEintrag) => ({
      id: e.id,
      name: '— noch nicht gesichert —',
      mime: 'application/octet-stream',
      groesse: e.groesse,
      hochgeladenAm: e.erstellt_am,
      hochgeladenVon: e.hochgeladen_von,
      ausstehend: true,
    }));

    const lokal = ablageVerbindungen.verbindungFürGuild(guildId);
    let ausLaufwerk: Zeile[] = [];
    if (lokal) {
      const speicher = await ablageVerbindungen.dateiSpeicherFür(lokal.id);
      if (speicher) {
        const liste = await speicher.liste();
        ausLaufwerk = liste.map((d) => ({ ...d, ausstehend: false }));
      }
    }
    zeilen = [...ausLaufwerk, ...ausZwischenlager];
  }

  async function pruefeStatus(): Promise<void> {
    const { verbunden } = await ablageGuildApi.laufwerkStatus(guildId);
    status = verbunden ? 'verbunden' : 'nicht_verbunden';
    if (verbunden) {
      await ladeListe();
      if (!stoppeFestigung) stoppeFestigung = starteFestigungsSchleife(guildId);
    }
  }

  onMount(() => {
    void pruefeStatus();
  });
  onDestroy(() => {
    stoppeFestigung?.();
  });

  async function nachVerbindung(v: AblageVerbindung): Promise<void> {
    verbindenOffen = false;
    // Die vom Nutzer geparste WebDAV-Basis ist die Freigabe-Adresse, die der
    // Server fuer die Weiterreich-Route braucht (Design §4.1) — nie der
    // rohe Link selbst (der bleibt in der Verbindungs-Konfiguration).
    const basis = v.konfiguration.basis;
    if (!basis) {
      fehler = 'Nur ein Nextcloud-Freigabe-Link kann als Community-Laufwerk dienen.';
      return;
    }
    await ablageVerbindungen.verknüpfeMitGuild(v.id, guildId);
    await ablageGuildApi.setzeLaufwerk(guildId, basis);
    await pruefeStatus();
  }

  async function hochladen(dateien: FileList | null): Promise<void> {
    if (!dateien?.length) return;
    const lokal = ablageVerbindungen.verbindungFürGuild(guildId);
    if (!lokal) {
      fehler = 'Dieses Gerät hat keinen Zugriffsschlüssel für dieses Laufwerk.';
      return;
    }
    laeuft = true;
    fehler = '';
    try {
      const hauptschlüssel = base64ZuBytes(lokal.hauptschlüsselB64);
      for (const datei of dateien) {
        const inhalt = new Uint8Array(await datei.arrayBuffer());
        const kopf = {
          name: datei.name,
          mime: datei.type || 'application/octet-stream',
          groesse: inhalt.length,
          hochgeladenAm: new Date().toISOString(),
          hochgeladenVon: '',
        };
        const container = await packeDateiContainer(hauptschlüssel, kopf, inhalt);
        const { upload_url } = await ablageGuildApi.zwischenlagerAnkuendigen(guildId, container.length);
        const antwort = await fetch(upload_url, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: container as unknown as BodyInit,
        });
        if (!antwort.ok) throw new Error(`Hochladen fehlgeschlagen: ${antwort.status}`);
      }
      await ladeListe(); // Serverseitige Kennung wird durch Neu-Laden bekannt, nicht gepflegt.
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  async function herunterladen(zeile: Zeile): Promise<void> {
    try {
      let inhalt: Uint8Array;
      let name = zeile.name;
      let mime = zeile.mime;
      const lokal = ablageVerbindungen.verbindungFürGuild(guildId);
      if (zeile.ausstehend) {
        const { url } = await ablageGuildApi.zwischenlagerDownloadUrl(guildId, zeile.id);
        const antwort = await fetch(url);
        if (!antwort.ok) throw new Error(`Herunterladen fehlgeschlagen: ${antwort.status}`);
        const container = new Uint8Array(await antwort.arrayBuffer());
        if (!lokal) {
          fehler = 'Dieses Gerät hat keinen Zugriffsschlüssel für dieses Laufwerk.';
          return;
        }
        const geöffnet = await öffneDateiContainer(base64ZuBytes(lokal.hauptschlüsselB64), container);
        inhalt = geöffnet.inhalt;
        name = geöffnet.kopf.name;
        mime = geöffnet.kopf.mime;
      } else {
        if (!lokal) return;
        const speicher = await ablageVerbindungen.dateiSpeicherFür(lokal.id);
        if (!speicher) return;
        const geöffnet = await speicher.herunterladen(zeile.id);
        inhalt = geöffnet.inhalt;
        name = geöffnet.name;
        mime = geöffnet.mime;
      }
      const blob = new Blob([inhalt as unknown as BlobPart], { type: sichererBlobTyp(mime) });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
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
      <p class="mb-3 text-sm text-muted-foreground">
        Noch kein Laufwerk verbunden. Verbinde eines, damit Mitglieder Dateien ablegen können.
      </p>
      <Button onclick={() => (verbindenOffen = true)} data-testid="community-ablage-verbinden">
        Laufwerk verbinden
      </Button>
    </div>
    {#if verbindenOffen}
      <div class="mt-3">
        <NextcloudVerbinden onVerbunden={nachVerbindung} />
      </div>
    {/if}
    {#if fehler}
      <p class="mt-2 text-sm text-destructive">{fehler}</p>
    {/if}
  {/if}
{:else}
  <div class="space-y-3" data-testid="community-ablage-ansicht">
    {#if fehler}
      <p class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {fehler}
      </p>
    {/if}
    <div class="min-h-[80px] rounded-lg border p-2">
      {#each zeilen as zeile (zeile.id)}
        <div class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted" data-testid="community-ablage-datei-{zeile.id}">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium">{zeile.name}</div>
            <div class="text-xs text-muted-foreground">
              {groesseText(zeile.groesse)}
              {#if zeile.ausstehend}
                · <ClockIcon class="inline size-3" /> noch nicht gesichert
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
        </div>
      {/each}
    </div>
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
  </div>
{/if}
