<script lang="ts">
  /**
   * Geraeteweites Medien-Archiv (Stufe B1, Plan
   * `docs/plans/2026-09-08-medien-nachziehen.md`): alle Medien dieses
   * Kontos ueber alle Gespraech hinweg — Bilderraster oben, Dateiliste
   * darunter, Muster wie `MedienuebersichtSheet` (das DM-Sheet bleibt
   * unangetastet; es zeigt nur die Sichtweite des geladenen Verlaufs).
   *
   * Datenquelle ist der Medien-Index (`STORE_MEDIEN`), gelesen mit
   * `medienLesen` — konto-gefiltert, neueste zuerst. Beim ERSTEN Oeffnen
   * laeuft einmal der Nachzug gegen `GET /meine-anhaenge` (best-effort,
   * Fehler still — das Blatt zeigt dann eben nur den lokalen Bestand);
   * danach deckt die Overlap-Abbruchkante den Zuwachs, kein Vollsweep pro
   * Start. Bytes laedt diese Seite nie voraus: verschluesselte DATEIEN
   * holt `anhangBlob` (derselbe Weg wie im DM-Sheet), Klartext-Bilder
   * bekommen nur ihre (kurzlebige) Adresse vorgeloggt, den Rest macht
   * `AutoRefreshImage`/`Lightbox` selbst.
   */
  import BottomSheet from './BottomSheet.svelte';
  import AutoRefreshImage from '$lib/components/AutoRefreshImage.svelte';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import FileIcon from '@lucide/svelte/icons/file';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import { m } from '$lib/paraglide/messages.js';
  import { formatBytes } from '$lib/utils/formatBytes';
  import type { Attachment } from '$lib/api/types';
  import { aktuellesKonto } from '$lib/verlauf/konto';
  import { medienLesen, medienIdVorhanden, medienSchreiben } from '$lib/verlauf/db';
  import { medienNachziehen } from '$lib/verlauf/medienNachzug';
  import { meineAnhaengeApi } from '$lib/api/meineAnhaenge';
  import { chatApi } from '$lib/api/chat';
  import type { MedienZeile } from '$lib/verlauf/schema';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let zeilen = $state<MedienZeile[]>([]);
  /** Objekt-URLs entschluesselter Dateien (Muster DM-Sheet). */
  let quellen = $state<Record<string, string>>({});
  /** Kurzlebige Adressen der Klartext-Bilder (id → url). */
  let adressen = $state<Record<string, { url: string; thumb_url: string | null }>>({});

  let geladen = $state(false);

  const istBild = (z: MedienZeile) =>
    (z.mime ?? '').startsWith('image/') && (!z.verschluesselt || z.schluessel !== null);
  const bilder = $derived(zeilen.filter(istBild));
  const dateien = $derived(zeilen.filter((z) => !istBild(z)));

  /** Erstes Oeffnen: einmal Nachzug (best-effort, still), dann Index lesen. */
  $effect(() => {
    if (!open || geladen) return;
    geladen = true;
    void (async () => {
      const kontoId = aktuellesKonto();
      if (kontoId !== null) {
        try {
          await medienNachziehen(meineAnhaengeApi.auflisten, {
            kontoId,
            liegtVor: (id) => medienIdVorhanden(id, kontoId),
            schreiben: medienSchreiben
          });
        } catch {
          /* best-effort: der lokale Bestand bleibt sichtbar */
        }
        zeilen = await medienLesen(kontoId).catch(() => []);
      }
    })();
  });

  /** Klartext-Anhänge brauchen eine Startadresse (30 min presigned): Bilder,
   *  damit `AutoRefreshImage` sie holt; Dateien, damit der Download-Knopf
   *  überhaupt erscheint. Dieselbe Refresh-Route, die auch dem 403-Nachsignieren
   *  dient. Entschluesselte Dateien: Objekt-URL über `anhangBlob`, wie im
   *  DM-Sheet.
   *  ponytail: ein Presign-Aufruf je Zeile je Öffnen — bei großen Archiven
   *  auf „Adresse erst beim Klick“ umstellen, das Blatt bleibt sonst
   *  ein Burst von Einzelabrufen. */
  $effect(() => {
    const klartext = zeilen.filter((z) => !z.verschluesselt);
    const verschluesselteDateien = dateien.filter((z) => z.verschluesselt && z.schluessel !== null);
    if (klartext.length === 0 && verschluesselteDateien.length === 0) return;
    let abgebrochen = false;
    void (async () => {
      const { anhangBlob } = await import('$lib/krypto/anhangHolen');
      for (const z of klartext) {
        if (abgebrochen) return;
        try {
          adressen[z.id] = await chatApi.refreshAttachmentDownloadUrl(z.id);
        } catch {
          /* Kachel bleibt beim Platzhalter, AutoRefreshImage zeigt den Grund */
        }
      }
      for (const z of verschluesselteDateien) {
        if (abgebrochen) return;
        const blob = await anhangBlob(
          z.id,
          z.schluessel ?? '',
          z.mime ?? 'application/octet-stream',
          false
        );
        if (abgebrochen) return;
        if (blob) quellen[z.id] = URL.createObjectURL(blob);
      }
    })();
    return () => {
      abgebrochen = true;
      for (const url of Object.values(quellen)) URL.revokeObjectURL(url);
      quellen = {};
    };
  });

  /** `MedienZeile` in die `Attachment`-Form, die `AutoRefreshImage`/`Lightbox`
   *  für den verschluesselten Weg brauchen (`anhang`-Parameter). */
  function alsAnhang(z: MedienZeile): Attachment {
    return {
      id: z.id,
      filename: z.dateiname,
      mime: z.mime,
      size: z.size,
      url: adressen[z.id]?.url ?? '',
      thumb_url: adressen[z.id]?.thumb_url ?? null,
      ...(z.verschluesselt ? { verschluesselt: true } : {}),
      ...(z.schluessel !== null ? { schluessel: z.schluessel } : {})
    };
  }

  let lightboxZeile = $state<MedienZeile | null>(null);
  let lightboxOffen = $state(false);

  function bildQuelle(z: MedienZeile): string {
    if (z.verschluesselt) return '';
    const adresse = adressen[z.id];
    return adresse?.thumb_url ?? adresse?.url ?? '';
  }
</script>

<BottomSheet
  {open}
  testid="media-archive-sheet"
  closeLabel={m.medien_schliessen()}
  panelClass="bg-popover text-popover-foreground border-border relative flex max-h-[80dvh] flex-col overflow-y-auto rounded-t-[22px] border-t pb-[var(--safe-bottom)] shadow-2xl"
  onClose={() => (open = false)}
>
  <div class="bg-border mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full"></div>
  <div class="px-4 pb-2" data-testid="media-archive-body">
    <p class="text-text-bright text-base font-bold">{m.medien_archiv_titel()}</p>

    {#if zeilen.length === 0}
      <p class="text-text-muted py-6 text-center text-xs">{m.medien_archiv_leer()}</p>
    {:else}
      {#if bilder.length > 0}
        <p class="text-text-muted mt-2 mb-1 text-xs font-bold uppercase">{m.medien_bilder()}</p>
        <div class="grid grid-cols-3 gap-1.5">
          {#each bilder as z (z.id)}
            <button
              type="button"
              class="aspect-square w-full cursor-zoom-in overflow-hidden rounded-lg border border-border"
              onclick={() => {
                lightboxZeile = z;
                lightboxOffen = true;
              }}
              aria-label={z.dateiname ?? m.medien_unbenannt()}
              data-testid={`media-archive-image-${z.id}`}
            >
              {#if !z.verschluesselt && bildQuelle(z) === ''}
                <!-- Adresse noch im Anflug (Refresh-Route liefert sie) -->
                <span class="bg-bg-hover/40 block size-full" aria-hidden="true"></span>
              {:else}
                <AutoRefreshImage
                  attachmentId={z.id}
                  src={bildQuelle(z)}
                  alt={z.dateiname ?? ''}
                  thumb={!z.verschluesselt && z.hatThumb}
                  anhang={z.verschluesselt ? alsAnhang(z) : null}
                  class="block size-full object-cover"
                />
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      {#if dateien.length > 0}
        <p class="text-text-muted mt-3 mb-1 text-xs font-bold uppercase">{m.medien_dateien()}</p>
        <ul class="flex flex-col gap-1">
          {#each dateien as z (z.id)}
            {@const quelle = z.verschluesselt ? (quellen[z.id] ?? null) : (adressen[z.id]?.url ?? null)}
            <li
              class="bg-bg-input flex items-center gap-2.5 rounded-xl border border-border px-3 py-2"
              data-testid={`media-archive-file-${z.id}`}
            >
              <FileIcon class="text-text-muted size-4 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="text-text-bright block truncate text-xs font-semibold"
                  >{z.dateiname ?? m.medien_unbenannt()}</span
                >
                <span class="text-text-muted block text-2xs">{formatBytes(z.size)}</span>
              </span>
              {#if quelle}
                <a
                  href={quelle}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={z.dateiname ?? 'anhang'}
                  class="text-primary hover:bg-bg-hover flex size-8 items-center justify-center rounded-full"
                  aria-label={m.medien_datei_laden()}
                  data-testid={`media-archive-file-download-${z.id}`}
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

{#if lightboxZeile}
  <Lightbox
    bind:open={lightboxOffen}
    attachmentId={lightboxZeile.id}
    src={bildQuelle(lightboxZeile)}
    alt={lightboxZeile.dateiname ?? ''}
    filename={lightboxZeile.dateiname}
    anhang={lightboxZeile.verschluesselt ? alsAnhang(lightboxZeile) : null}
  />
{/if}
