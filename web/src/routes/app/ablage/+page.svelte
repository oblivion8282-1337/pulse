<script lang="ts">
  import { syncOrdnerMoeglich, adapterAusVerzeichnis } from '$lib/ablage/syncOrdner';
  import type { AblageVerzeichnis } from '$lib/ablage/syncOrdner';
  import { DateiSpeicher } from '$lib/ablage/dateispeicher';
  import type { DateiInfo } from '$lib/ablage/dateispeicher';
  import { Button } from '$lib/components/ui/button/index.js';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import FileIcon from '@lucide/svelte/icons/file';
  import FolderIcon from '@lucide/svelte/icons/folder';

  let ordnerName = $state('');
  let speicher = $state<DateiSpeicher | null>(null);
  let dateien = $state<DateiInfo[]>([]);
  let laeuft = $state(false);
  let dragAktiv = $state(false);
  let fehler = $state('');

  function symbol(mime: string): string {
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.includes('pdf')) return '📄';
    if (mime.includes('sheet') || mime.includes('excel')) return '📊';
    if (mime.startsWith('text/')) return '📝';
    return '📄';
  }

  function groesseText(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function ordnerWählen(): Promise<void> {
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
      ordnerName = (verzeichnis as unknown as { name?: string }).name ?? 'Ablage';
      await speicher.laden();
      dateien.length = 0;
      dateien.push(...await speicher.liste());
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

  async function hochladen(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const hochgeladene = input.files;
    if (!hochgeladene?.length || !speicher) return;
    laeuft = true;
    fehler = '';
    try {
      for (const datei of hochgeladene) {
        const bytes = new Uint8Array(await datei.arrayBuffer());
        await speicher.hochladen(datei.name, datei.type || 'application/octet-stream', bytes, 'dev');
      }
      await speicher.laden();
      dateien.length = 0;
      dateien.push(...await speicher.liste());
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      input.value = '';
      laeuft = false;
    }
  }

  async function herunterladen(datei: DateiInfo): Promise<void> {
    try {
      const { inhalt } = await speicher!.herunterladen(datei.id);
      const blob = new Blob([inhalt as unknown as BlobPart], { type: datei.mime });
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
    try {
      await speicher!.löschen(datei.id);
      await speicher!.laden();
      dateien = await speicher!.liste();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragAktiv = false;
    if (e.dataTransfer?.files.length && speicher) {
      hochladen({ target: { files: e.dataTransfer.files, value: '' } } as unknown as Event);
    }
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    dragAktiv = true;
  }
</script>

<svelte:head><title>Ablage</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 p-6">
  <div>
    <h1 class="text-xl font-bold">Verschlüsselte Ablage</h1>
    <p class="text-sm text-muted-foreground">
      Wähle einen Ordner in deinem Cloud-Sync (OneDrive, Dropbox, Nextcloud …).
      Alle Dateien werden clientseitig verschlüsselt und von deinem Sync-Client
      in deine Cloud getragen. Der Pulse-Server sieht den Inhalt nie.
    </p>
  </div>

  {#if !speicher}
    <div class="flex flex-col items-center gap-4 py-12">
      <div class="text-4xl">📁</div>
      <Button onclick={ordnerWählen} data-testid="ablage-ordner-wählen">
        Ordner wählen
      </Button>
      <p class="text-xs text-muted-foreground">
        Chrome oder Edge nutzen. Der Ordner wird von deinem Sync-Client in die Cloud getragen.
      </p>
    </div>
  {:else}
    <div class="rounded-lg border p-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium">Ordner: {ordnerName}</p>
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
          Noch keine Dateien. Zieh sie hierher oder nutze den Knopf unten.
        </p>
      {:else}
        {#each dateien as datei (datei.id)}
          <div class="group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted" data-testid="ablage-datei">
            <span class="text-lg">{datei.mime.startsWith('image/') ? '🖼️' : '📄'}</span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{datei.name}</div>
              <div class="text-xs text-muted-foreground">{groesseText(datei.groesse)}</div>
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

    {#if fehler}
      <p class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {fehler}
      </p>
    {/if}
  {/if}
</div>
