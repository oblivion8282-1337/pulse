<script lang="ts">
  /**
   * Die Ablage-Ansicht: Dateien eines Ablage-Kanals hochladen, auflisten,
   * herunterladen und löschen. Der DateiSpeicher kommt als Prop — der
   * Aufrufer entscheidet, welcher Adapter dahintersteckt (Sync-Ordner,
   * WebDAV, Dropbox, OneDrive, Google Drive, S3).
   *
   * Alle Inhalte werden clientseitig verschlüsselt (PADF-Container),
   * bevor sie den Adapter erreichen. Der Server sieht nur Kanalstruktur.
   *
   * **Diese Datei haengt noch an keiner Stelle** und ist trotzdem keine
   * Leiche: sie ist die Ansicht, die die Community-Dateiablage bekommt
   * (Etappe E8). Wer hier aufraeumt, loescht die Vorarbeit.
   */

  import { DateiSpeicher } from '$lib/ablage/dateispeicher';
  import { sichererBlobTyp } from '$lib/krypto/sichererBlobTyp';
  import type { DateiInfo } from '$lib/ablage/dateispeicher';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import FileIcon from '@lucide/svelte/icons/file';
  import ImageIcon from '@lucide/svelte/icons/image';
  import SheetIcon from '@lucide/svelte/icons/sheet';
  import { Button } from '$lib/components/ui/button/index.js';

  let { speicher, hochgeladenVon = '' }: {
    speicher: DateiSpeicher;
    hochgeladenVon?: string;
  } = $props();

  let dateien: DateiInfo[] = $state([]);
  let laeuft = $state(false);
  let fehler = $state('');
  let dragAktiv = $state(false);
  let dateiInput: HTMLInputElement | null = $state(null);

  function symbol(mime: string): string {
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.includes('pdf')) return '📄';
    if (mime.includes('spreadsheet') || mime.includes('excel')) return '📊';
    if (mime.startsWith('text/')) return '📝';
    return '📄';
  }

  function groesseText(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function neuLaden(): Promise<void> {
    dateien = await speicher.liste();
  }

  async function hochladen(dateien_: FileList | null): Promise<void> {
    if (!dateien_?.length) return;
    laeuft = true;
    fehler = '';
    try {
      for (const datei of dateien_) {
        const bytes = new Uint8Array(await datei.arrayBuffer());
        await speicher.hochladen(datei.name, datei.type || 'application/octet-stream', bytes, hochgeladenVon);
      }
      await neuLaden();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    } finally {
      laeuft = false;
    }
  }

  async function herunterladen(datei: DateiInfo): Promise<void> {
    try {
      const { inhalt } = await speicher.herunterladen(datei.id);
      // Wie bei den Nachrichten-Anhaengen: der Typ stammt vom Hochladenden
      // aus dem verschluesselten Kopf, nicht vom Server.
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
    try {
      await speicher.löschen(datei.id);
      await neuLaden();
    } catch (e) {
      fehler = e instanceof Error ? e.message : String(e);
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragAktiv = false;
    if (e.dataTransfer?.files.length) {
      hochladen(e.dataTransfer.files);
    }
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    dragAktiv = true;
  }

  // Initial laden
  $effect(() => {
    neuLaden();
  });
</script>

<div class="space-y-3">
  {#if fehler}
    <p class="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {fehler}
    </p>
  {/if}

  <div
    class="min-h-[120px] rounded-lg border border-dashed p-4 transition-colors {dragAktiv
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
        Noch keine Dateien. Zieh sie hierher oder nutze den Hochladen-Knopf.
      </p>
    {:else}
      {#each dateien as datei (datei.id)}
        <div class="group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted" data-testid="ablage-datei-{datei.id}">
          <span class="text-lg">{symbol(datei.mime)}</span>
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

  <div class="flex items-center justify-between">
    <input
      type="file"
      multiple
      class="hidden"
      bind:this={dateiInput}
      onchange={(e) => hochladen((e.target as HTMLInputElement).files)}
    />
    <Button
      variant="secondary"
      size="sm"
      disabled={laeuft}
      onclick={() => dateiInput?.click()}
      data-testid="ablage-hochladen"
    >
      <UploadIcon class="mr-1 size-4" />
      Hochladen
    </Button>
    {#if dateien.length > 0}
      <span class="text-xs text-muted-foreground">
        {dateien.length} Datei{dateien.length !== 1 ? 'en' : ''}
      </span>
    {/if}
  </div>
</div>
