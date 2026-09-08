<script lang="ts">
  /**
   * Medienübersicht pro Chat (Übergabe P1.7): alle Bilder und Dateien der
   * geladenen Unterhaltung in einem Blatt — Bilderraster oben, Dateiliste
   * darunter, Klick öffnet Lightbox bzw. Download.
   *
   * Die Daten kommen aus dem NACHRICHTEN-Store (nicht aus IndexedDB): das
   * Blatt zeigt genau den Verlauf, den der Chat ohnehin kennt — ältere
   * Medien erscheinen, sobald der Nutzer in der Historie zurückscrollt.
   * Verschlüsselte Bilder laufen über `AutoRefreshImage` ( Holt + Objekt-
   * URL, wie in `MessageAttachments`), Dateien über den `quellen`-Effekt
   * mit `anhangBlob`; das Muster ist bewusst dasselbe wie dort.
   */
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import AutoRefreshImage from '$lib/components/AutoRefreshImage.svelte';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import FileIcon from '@lucide/svelte/icons/file';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import type { Attachment, Message } from '$lib/api/types';
  import { m } from '$lib/paraglide/messages.js';
  import { formatBytes } from '$lib/utils/formatBytes';

  let {
    messages,
    open = $bindable(false)
  }: {
    messages: Message[];
    open?: boolean;
  } = $props();

  let quellen = $state<Record<string, string>>({});

  const alleAnhaenge = $derived(messages.flatMap((n) => n.attachments ?? []));
  const bilder = $derived(alleAnhaenge.filter((a) => (a.mime ?? '').startsWith('image/')));
  const dateien = $derived(alleAnhaenge.filter((a) => !(a.mime ?? '').startsWith('image/')));
  const verschluesselteDateien = $derived(dateien.filter((a) => a.verschluesselt));

  $effect(() => {
    const liste = verschluesselteDateien;
    if (liste.length === 0) return;
    let abgebrochen = false;
    const erzeugt: string[] = [];
    const gesammelt: Record<string, string> = {};
    void (async () => {
      const { anhangBlob } = await import('$lib/krypto/anhangHolen');
      for (const a of liste) {
        if (abgebrochen) return;
        const blob = a.schluessel
          ? await anhangBlob(a.id, a.schluessel, a.mime ?? 'application/octet-stream', false)
          : null;
        if (abgebrochen) return;
        const url = blob ? URL.createObjectURL(blob) : '';
        erzeugt.push(url);
        gesammelt[a.id] = url;
        quellen = { ...quellen, ...gesammelt };
      }
    })();
    return () => {
      abgebrochen = true;
      for (const url of erzeugt) URL.revokeObjectURL(url);
      quellen = {};
    };
  });

  let lightboxAnhang = $state<Attachment | null>(null);
  let lightboxOffen = $state(false);

  function bildOeffnen(a: Attachment): void {
    lightboxAnhang = a;
    lightboxOffen = true;
  }

  function dateiQuelle(a: Attachment): string | null {
    if (!a.verschluesselt) return a.url;
    return quellen[a.id] ?? null;
  }
</script>

<BottomSheet
  {open}
  testid="media-sheet"
  closeLabel={m.medien_schliessen()}
  panelClass="bg-popover text-popover-foreground border-border relative flex max-h-[80dvh] flex-col overflow-y-auto rounded-t-[22px] border-t pb-[var(--safe-bottom)] shadow-2xl"
  onClose={() => (open = false)}
>
  <div class="bg-border mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full"></div>
  <div class="px-4 pb-2" data-testid="media-sheet-body">
    <p class="text-text-bright text-base font-bold">{m.medien_titel()}</p>

    {#if alleAnhaenge.length === 0}
      <p class="text-text-muted py-6 text-center text-xs">{m.medien_leer()}</p>
    {:else}
      {#if bilder.length > 0}
        <p class="text-text-muted mt-2 mb-1 text-xs font-bold uppercase">{m.medien_bilder()}</p>
        <div class="grid grid-cols-3 gap-1.5">
          {#each bilder as a (a.id)}
            <button
              type="button"
              class="aspect-square w-full cursor-zoom-in overflow-hidden rounded-lg border border-border"
              onclick={() => bildOeffnen(a)}
              aria-label={a.filename ?? m.medien_bild_oeffnen()}
              data-testid={`media-image-${a.id}`}
            >
              <AutoRefreshImage
                attachmentId={a.id}
                src={a.thumb_url ?? a.url}
                alt={a.filename ?? ''}
                thumb={a.verschluesselt
                  ? a.thumb_schluessel !== null && a.thumb_schluessel !== undefined
                  : a.thumb_url !== null && a.thumb_url !== undefined}
                anhang={a.verschluesselt ? a : null}
                class="block size-full object-cover"
              />
            </button>
          {/each}
        </div>
      {/if}

      {#if dateien.length > 0}
        <p class="text-text-muted mt-3 mb-1 text-xs font-bold uppercase">{m.medien_dateien()}</p>
        <ul class="flex flex-col gap-1">
          {#each dateien as a (a.id)}
            {@const quelle = dateiQuelle(a)}
            <li
              class="bg-bg-input flex items-center gap-2.5 rounded-xl border border-border px-3 py-2"
              data-testid={`media-file-${a.id}`}
            >
              <FileIcon class="text-text-muted size-4 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="text-text-bright block truncate text-xs font-semibold"
                  >{a.filename ?? m.medien_unbenannt()}</span
                >
                <span class="text-text-muted block text-2xs">{formatBytes(a.size)}</span>
              </span>
              {#if quelle}
                <a
                  href={quelle}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={a.filename ?? 'anhang'}
                  class="text-primary hover:bg-bg-hover flex size-8 items-center justify-center rounded-full"
                  aria-label={m.medien_datei_laden()}
                  data-testid={`media-file-download-${a.id}`}
                >
                  <DownloadIcon class="size-4" />
                </a>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</BottomSheet>

{#if lightboxAnhang}
  <Lightbox
    bind:open={lightboxOffen}
    attachmentId={lightboxAnhang.id}
    src={lightboxAnhang.thumb_url ?? lightboxAnhang.url}
    alt={lightboxAnhang.filename ?? ''}
    filename={lightboxAnhang.filename}
    anhang={lightboxAnhang.verschluesselt ? lightboxAnhang : null}
  />
{/if}
