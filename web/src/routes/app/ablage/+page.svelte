<script lang="ts">
  /**
   * Die Ablage-Seite: verbinde ein Cloud-Laufwerk und verwalte Dateien.
   *
   * Zwei Wege:
   * - Dropbox (OAuth): direkt in den App-Ordner des Nutzers, verschlüsselt
   * - Sync-Ordner: lokaler Ordner, Sync-Client trägt in die Cloud
   *
   * Beide nutzen dieselbe Engine (DateiSpeicher) und dieselben Container.
   * Der Server sieht nur Kanalstruktur — keine Namen, keine Bytes.
   *
   * **Bewusst ohne Menüpunkt** (Etappe E1, Aufgabe 6 — hatte auch vorher
   * keinen, nur die direkte URL erreichte die Seite). Ist trotzdem keine
   * Leiche: die Dateiansicht hier wird in Etappe E8 zur
   * Community-Dateiablage (siehe `DateiablageAnsicht.svelte`, die auf
   * genau diesen Umzug wartet). Wer hier aufräumt, löscht die Vorarbeit.
   */

  import { syncOrdnerMoeglich, adapterAusVerzeichnis } from '$lib/ablage/syncOrdner';
  import type { AblageVerzeichnis } from '$lib/ablage/syncOrdner';
  import {
    autorisierungsAdresse,
    tauscheCodeAus,
    dropboxAdapter,
    type DropboxAnbindung,
  } from '$lib/ablage/dropbox';
  import type { Pkce } from '$lib/ablage/oauth';
  import { DateiSpeicher } from '$lib/ablage/dateispeicher';
  import { sichererBlobTyp } from '$lib/krypto/sichererBlobTyp';
  import type { DateiInfo } from '$lib/ablage/dateispeicher';
  import { Button } from '$lib/components/ui/button/index.js';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import FileIcon from '@lucide/svelte/icons/file';
  import ImageIcon from '@lucide/svelte/icons/image';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import SheetIcon from '@lucide/svelte/icons/sheet';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import FolderIcon from '@lucide/svelte/icons/folder';

  // Öffentliche OAuth-Client-Id, kein Geheimnis — sie steht ohnehin im
  // ausgelieferten Bundle. Sie kann sich zwischen Aufstellungen unterscheiden
  // (eigene Dropbox-App pro Redirect-URI), deshalb per Build-Zeit-Variable
  // statt fest verdrahtet, Muster wie `PULSE_PLUGIN_PERMISSIONS` in
  // `lib/plugins/registry.ts`. Vorgabe = die bisherige feste Kennung.
  const DROPBOX_KEY = import.meta.env.PULSE_DROPBOX_CLIENT_ID ?? 'pld01d3rc2ydqw5';

  let speicher = $state<DateiSpeicher | null>(null);
  let quelle = $state('');
  let dateien = $state<DateiInfo[]>([]);
  let laeuft = $state(false);
  let dragAktiv = $state(false);
  let fehler = $state('');
  let meldung = $state('');

  function symbol(mime: string): typeof FileIcon {
    if (mime.startsWith('image/')) return ImageIcon;
    if (mime.includes('sheet') || mime.includes('excel')) return SheetIcon;
    if (mime.includes('pdf') || mime.startsWith('text/')) return FileTextIcon;
    return FileIcon;
  }

  function groesseText(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // --- Dropbox OAuth ---

  async function erzeugePkceSync(): Promise<{ pruefer: string; herausforderung: string }> {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const pruefer = btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const roh = new Uint8Array(
      await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pruefer)),
    );
    const herausforderung = btoa(String.fromCharCode(...roh))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    return { pruefer, herausforderung };
  }

  function zufallsState(): string {
    return `ablage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // Wird nach dem OAuth-Redirect aufgerufen: Dropbox schickt ?code=...&state=...
  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    const anbieter = params.get('anbieter');
    if (!code) return;
    if (error) {
      fehler = `Verbindung abgelehnt: ${error}`;
      return;
    }
    if (anbieter !== 'dropbox') return;

    const verifier = sessionStorage.getItem('ablage_pkce_verifier') ?? '';
    const anbindung: DropboxAnbindung = { kundenId: DROPBOX_KEY };
    tauscheCodeAus(anbindung, code, { pruefer: verifier, herausforderung: '' })
      .then((zugang) => {
        sessionStorage.setItem('ablage_dropbox_token', zugang.zugangsToken);
        dropboxVerbinden(zugang.zugangsToken);
      })
      .catch((e) => {
        fehler = `Token-Tausch fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
      });
  });

  async function dropboxVerbinden(token?: string): Promise<void> {
    if (!token) {
      // Kein Token → OAuth-Redirect zu Dropbox starten
      const anbindung: DropboxAnbindung = { kundenId: DROPBOX_KEY };
      const pkce = await erzeugePkceSync();
      const zustand = zufallsState();
      sessionStorage.setItem('ablage_pkce_verifier', pkce.pruefer);
      sessionStorage.setItem('ablage_oauth_state', zustand);
      const url = autorisierungsAdresse(anbindung, pkce, zustand);
      window.location.href = url;
      return;
    }
    const adapter = dropboxAdapter({
      zugangsToken: token,
      ordner: 'ablage',
    });
    speicher = new DateiSpeicher(adapter, 'ablage', holeSchlüssel());
    quelle = 'Dropbox (App-Ordner)';
  }

  // --- Sync-Ordner ---

  async function syncOrdnerVerbinden(): Promise<void> {
    try {
      const wahl = (window as unknown as {
        showDirectoryPicker?: (o?: { mode?: string }) => Promise<AblageVerzeichnis>;
      }).showDirectoryPicker;
      if (!wahl) {
        fehler = 'Dieser Browser kann keine Ordner wählen — Chrome oder Edge nehmen.';
        return;
      }
      const verzeichnis: AblageVerzeichnis = await wahl({ mode: 'readwrite' });
      const adapter = adapterAusVerzeichnis(verzeichnis);
      const schlüssel = holeSchlüssel();
      speicher = new DateiSpeicher(adapter, 'ablage', schlüssel);
      quelle = `Sync-Ordner: ${(verzeichnis as unknown as { name: string }).name}`;
      await speicher.laden();
      dateien = await speicher.liste();
      meldung = 'Sync-Ordner verbunden.';
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        fehler = e instanceof Error ? e.message : String(e);
      }
    }
  }

  function holeSchlüssel(): Uint8Array {
    const key = 'pulse-ablage-hauptschluessel';
    let b64 = localStorage.getItem(key);
    if (!b64) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      b64 = btoa(String.fromCharCode(...bytes));
      localStorage.setItem(key, b64);
    }
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  // --- Dateioperationen ---

  async function hochladen(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const dateiListe = input.files;
    if (!dateiListe?.length || !speicher) return;
    laeuft = true;
    fehler = '';
    try {
      for (const datei of dateiListe) {
        const bytes = new Uint8Array(await datei.arrayBuffer());
        await speicher.hochladen(datei.name, datei.type || 'application/octet-stream', bytes, 'dev');
      }
      await speicher.laden();
      dateien = await speicher.liste();
      meldung = `${dateiListe.length} Datei(en) hochgeladen.`;
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      input.value = '';
      laeuft = false;
    }
  }

  async function herunterladen(datei: DateiInfo): Promise<void> {
    if (!speicher) return;
    try {
      const { inhalt } = await speicher.herunterladen(datei.id);
      // Wie bei den Nachrichten-Anhaengen: der Typ stammt aus dem
      // verschluesselten Kopf des Hochladenden, nicht vom Server
      // (`krypto/sichererBlobTyp.ts`). Hier setzt der Code `a.download`
      // ohnehin fest, die Herunterstufung ist die zweite Haelfte.
      const blob = new Blob([inhalt as unknown as BlobPart], {
        type: sichererBlobTyp(datei.mime),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = datei.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
  }

  async function löschen(datei: DateiInfo): Promise<void> {
    if (!speicher) return;
    try {
      await speicher.löschen(datei.id);
      await speicher.laden();
      dateien = await speicher.liste();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragAktiv = false;
    if (e.dataTransfer?.files.length && speicher) {
      const dt = e.dataTransfer;
      hochladen({ target: { files: dt.files, value: '' } } as unknown as Event);
    }
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    dragAktiv = true;
  }
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
  <div>
    <h1 class="text-xl font-bold">Verschlüsselte Ablage</h1>
    <p class="text-sm text-muted-foreground">
      Verbinde ein Cloud-Laufwerk. Alle Dateien werden clientseitig verschlüsselt —
      der Pulse-Server sieht den Inhalt nie.
    </p>
  </div>

  {#if fehler}
    <div class="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
      {fehler}
    </div>
  {/if}

  {#if !speicher}
    <div class="space-y-4">
      <p class="text-sm text-muted-foreground">Wähle einen Anbieter:</p>

      <button
        class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent"
        onclick={() => dropboxVerbinden()}
        data-testid="verbinden-dropbox"
      >
        <CloudIcon class="size-6 text-muted-foreground" />
        <div>
          <div class="font-semibold">Dropbox</div>
          <div class="text-xs text-muted-foreground">App-Ordner — nur Pulse sieht ihn</div>
        </div>
      </button>

      <button
        class="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent"
        onclick={syncOrdnerVerbinden}
        data-testid="verbinden-sync-ordner"
      >
        <FolderIcon class="size-6 text-muted-foreground" />
        <div>
          <div class="font-semibold">Sync-Ordner</div>
          <div class="text-xs text-muted-foreground">Lokaler Ordner, dein Sync-Client trägt hoch — kein Konto nötig</div>
        </div>
      </button>

      <div class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        OneDrive und Google Drive kommen mit der Krypto-Etappe — die Anbindungen
        sind gebaut (<code>onedrive.ts</code>, <code>gdrive.ts</code>) und warten
        auf Client-IDs von den Entwicklerportalen.
      </div>
    </div>
  {:else}
    <div class="rounded-lg border p-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">{quelle}</p>
          <p class="text-xs text-muted-foreground">{dateien.length} Dateien · verschlüsselt</p>
        </div>
        <Button variant="ghost" size="sm" onclick={() => { speicher = null; dateien = []; }}>
          Wechseln
        </Button>
      </div>
    </div>

    <div
      class="min-h-[200px] rounded-lg border border-dashed p-4 transition-colors {dragAktiv
        ? 'border-primary bg-primary/5'
        : 'border-border'}"
      role="region"
      aria-label="Dateiablage"
      ondrop={onDrop}
      ondragover={onDragOver}
      ondragleave={() => (dragAktiv = false)}
    >
      {#if dateien.length === 0}
        <p class="py-6 text-center text-sm text-muted-foreground">
          Noch keine Dateien. Lade welche hoch oder zieh sie hierher.
        </p>
      {:else}
        {#each dateien as datei (datei.id)}
          {@const Icon = symbol(datei.mime)}
          <div class="group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted">
            <Icon class="size-4 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{datei.name}</div>
              <div class="text-xs text-muted-foreground">{groesseText(datei.groesse)} · {datei.hochgeladenVon}</div>
            </div>
            <div class="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                class="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Herunterladen"
                onclick={() => herunterladen(datei)}
              >
                <DownloadIcon class="size-4" />
              </button>
              <button
                class="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                title="Löschen"
                onclick={() => löschen(datei)}
              >
                <Trash2Icon class="size-4" />
              </button>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="flex items-center gap-3">
      <label>
        <input type="file" multiple class="hidden" onchange={hochladen} disabled={laeuft} />
        <span class="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
          <UploadIcon class="size-4" />
          Hochladen
        </span>
      </label>
      <Button variant="secondary" size="sm" onclick={() => speicher?.laden()} disabled={laeuft}>
        Neu laden
      </Button>
    </div>

    {#if meldung}
      <p class="text-sm text-muted-foreground">{meldung}</p>
    {/if}
  {/if}
</div>
