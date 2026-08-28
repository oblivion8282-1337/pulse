<!--
  Renders the attachments block under a message's content.

  Type-driven dispatch:
   - image/*   → AutoRefreshImage clickable → Lightbox
   - video/*   → native <video controls>
   - audio/*   → native <audio controls>
   - application/pdf → embed-card (link out, no inline pdf — most browsers'
                       built-in viewer is fine via the download anyway)
   - everything else → download-card with filename + size + icon

  Sizes are capped via CSS — a giant screenshot doesn't blow up the
  message column. The Lightbox is the route to actual-size viewing.

  **Verschluesselte Anhaenge (Etappe E):** fuer sie kann eine direkte Adresse
  prinzipiell nicht funktionieren — was im Objektspeicher liegt, ist
  Kauderwelsch, ein `<video src=…>` darauf zeigt nichts. Bilder gingen mit
  `AutoRefreshImage`/`blobCache` ohnehin schon ueber Holen + Objekt-URL; Video,
  Audio und der Herunterladen-Knopf tun es seither auch (`quellen` unten). Der
  KLARTEXT-Fall bleibt unveraendert: dort ist `quelle(a)` schlicht `a.url`, es
  wird nichts geholt und nichts zwischengespeichert.

  Layout reservation (important): the message list is virtualised, and virtua
  measures an item's height the moment it mounts. A media element that only
  gets its height once the bytes arrive therefore reports ~0px first and its
  real height later — the list's total height then jumps by hundreds of pixels
  while the user scrolls, which yanks the scroll position around. So the box
  is sized up front from the stored `width`/`height` (the composer records them
  on upload) and the media fills it.
-->
<script lang="ts">
  import type { Attachment } from '$lib/api/types';
  import AutoRefreshImage from './AutoRefreshImage.svelte';
  import Lightbox from './Lightbox.svelte';
  import FileIcon from '@lucide/svelte/icons/file';
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import { m } from '$lib/paraglide/messages.js';

  let { attachments }: { attachments: Attachment[] } = $props();

  let lightboxAttachment = $state<Attachment | null>(null);
  let lightboxOpen = $state(false);

  /** Objekt-URLs der verschluesselten Nicht-Bild-Anhaenge dieser Nachricht.
   *  `undefined` = laeuft noch, `''` = endgueltig nicht verfuegbar (der
   *  Klumpen ist mit seiner letzten Zustellung gefallen, s.
   *  `krypto/anhangHolen.ts`), sonst die fertige Adresse. */
  let quellen = $state<Record<string, string>>({});

  // Bilder bleiben aussen vor: die holt `AutoRefreshImage` selbst, samt
  // ref-gezaehltem Zwischenspeicher fuer die virtualisierte Liste.
  const zuHolen = $derived(
    attachments.filter((a) => a.verschluesselt && kind(a.mime) !== 'image')
  );

  $effect(() => {
    const liste = zuHolen;
    if (liste.length === 0) return;
    let abgebrochen = false;
    const erzeugt: string[] = [];
    // Eigener Sammler statt `{ ...quellen }`: ein Lesen des eigenen `$state`
    // im Effekt machte ihn von sich selbst abhaengig.
    const gesammelt: Record<string, string> = {};
    void (async () => {
      const { anhangBlob } = await import('$lib/krypto/anhangHolen');
      for (const a of liste) {
        if (abgebrochen) return;
        const blob = a.schluessel
          ? await anhangBlob(a.id, a.schluessel, a.mime ?? 'application/octet-stream', false)
          : null;
        if (abgebrochen) return;
        if (blob) {
          const url = URL.createObjectURL(blob);
          erzeugt.push(url);
          gesammelt[a.id] = url;
        } else {
          gesammelt[a.id] = '';
        }
        quellen = { ...gesammelt };
      }
    })();
    // Beim Verlassen freigeben — anders als bei den Bildern gibt es hier
    // keinen geteilten Zwischenspeicher, die URLs gehoeren dieser Instanz.
    return () => {
      abgebrochen = true;
      for (const url of erzeugt) URL.revokeObjectURL(url);
      quellen = {};
    };
  });

  /** Was ins `src`/`href` gehoert. Im Klartext-Fall unveraendert `a.url`;
   *  im verschluesselten der Objekt-URL, `null` solange er laeuft, `''` wenn
   *  es ihn endgueltig nicht gibt. */
  function quelle(a: Attachment): string | null {
    if (!a.verschluesselt) return a.url;
    return quellen[a.id] ?? null;
  }

  function openLightbox(a: Attachment) {
    lightboxAttachment = a;
    lightboxOpen = true;
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function kind(mime: string | null): 'image' | 'video' | 'audio' | 'pdf' | 'other' {
    if (!mime) return 'other';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    return 'other';
  }

  /** Inline `style` that pins an image's box before a single byte has loaded:
   *  intrinsic width (shrunk by `max-w-md` / a narrow column) plus the source
   *  aspect ratio, so the height is known from the first layout pass.
   *  Returns '' for pre-dimension attachments — those keep the old behaviour
   *  rather than getting a guessed, possibly wrong, box. */
  function reserveBox(a: Attachment): string {
    const w = a.width ?? 0;
    const h = a.height ?? 0;
    if (w <= 0 || h <= 0) return '';
    return `width:${w}px;aspect-ratio:${w} / ${h};`;
  }
</script>

{#if attachments.length > 0}
  <div class="mt-1.5 flex flex-col gap-1.5" data-testid="message-attachments">
    {#each attachments as a (a.id)}
      {@const k = kind(a.mime)}
      {#if k === 'image'}
        {@const box = reserveBox(a)}
        <button
          type="button"
          class="block max-h-96 w-fit max-w-md cursor-zoom-in overflow-hidden rounded-xl border border-border focus:outline-none focus:ring-2 focus:ring-primary"
          style={box}
          onclick={() => openLightbox(a)}
          data-testid="attachment-image"
          aria-label={m.message_attachments_open_image({ filename: a.filename ?? m.message_attachments_unnamed() })}
        >
          <AutoRefreshImage
            attachmentId={a.id}
            src={a.thumb_url ?? a.url}
            alt={a.filename ?? ''}
            thumb={a.verschluesselt
              ? a.thumb_schluessel !== null && a.thumb_schluessel !== undefined
              : a.thumb_url !== null && a.thumb_url !== undefined}
            anhang={a.verschluesselt ? a : null}
            class={box ? 'block size-full object-cover' : 'block max-h-96 w-auto object-cover'}
          />
        </button>
      {:else if k === 'video'}
        {@const quelleVideo = quelle(a)}
        <!-- `preload="metadata"` means the intrinsic size lands late; without a
             reserved box the element starts at the 300×150 default and resizes
             once metadata arrives. Uploads carry no dimensions for video, so
             16/9 is the fallback ratio (the element letterboxes anything else). -->
        <video
          src={quelleVideo ?? undefined}
          controls
          preload="metadata"
          class="block max-h-96 w-full max-w-md rounded-xl border border-border"
          style={reserveBox(a) || 'aspect-ratio:16 / 9;'}
          data-testid="attachment-video"
        >
          <track kind="captions" />
        </video>
      {:else if k === 'audio'}
        {@const quelleAudio = quelle(a)}
        <audio
          src={quelleAudio ?? undefined}
          controls
          preload="metadata"
          class="block w-full max-w-md"
          data-testid="attachment-audio"
        ></audio>
      {:else}
        {@const quelleDatei = quelle(a)}
        <a
          href={quelleDatei || undefined}
          target="_blank"
          rel="noopener noreferrer"
          class="bg-bg-input hover:bg-bg-hover flex w-fit max-w-md items-center gap-3 rounded-xl border border-border px-3 py-2.5 text-sm transition-colors"
          data-testid="attachment-download"
          download={a.filename ?? undefined}
        >
          <div class="text-text-muted shrink-0">
            {#if k === 'pdf'}
              <FileTextIcon class="size-5" />
            {:else}
              <FileIcon class="size-5" />
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-text-bright truncate font-medium">
              {a.filename ?? m.message_attachments_unnamed()}
            </p>
            <p class="text-text-muted text-xs">
              {quelleDatei === '' ? m.message_attachments_unavailable() : fmtBytes(a.size)}
            </p>
          </div>
          <DownloadIcon class="text-text-muted size-4 shrink-0" />
        </a>
      {/if}
    {/each}
  </div>
{/if}

{#if lightboxAttachment}
  <Lightbox
    bind:open={lightboxOpen}
    attachmentId={lightboxAttachment.id}
    src={lightboxAttachment.url}
    alt={lightboxAttachment.filename ?? ''}
    filename={lightboxAttachment.filename}
    anhang={lightboxAttachment.verschluesselt ? lightboxAttachment : null}
  />
{/if}
