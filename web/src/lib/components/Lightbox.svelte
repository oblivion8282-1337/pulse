<!--
  Click-to-open full-size image overlay. Built on bits-ui Dialog so we get
  focus-trap + ESC + click-outside-to-close for free. The image itself sits
  inside `AutoRefreshImage` so a long-open lightbox still loads after a
  presigned-URL expiry.

  Renderer-side this is only mounted when the user clicks an image
  attachment — keeps the DOM clean.
-->
<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';
  import AutoRefreshImage from './AutoRefreshImage.svelte';
  import XIcon from '@lucide/svelte/icons/x';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import { m } from '$lib/paraglide/messages.js';
  import type { Attachment } from '$lib/api/types';
  import { dateiTeilenOderLaden } from '$lib/platform/dateiTeilen';
  import {
    ZOOM_AUS,
    begrenzeStand,
    doppeltippStand,
    pinchStand,
    type Zoomstand
  } from './lightboxZoom';

  let {
    open = $bindable(false),
    attachmentId,
    src,
    alt = '',
    filename,
    anhang = null
  } = $props<{
    open?: boolean;
    attachmentId: string;
    src: string;
    alt?: string;
    filename?: string | null;
    /** Nur bei einem VERSCHLUESSELTEN Anhang gesetzt — wird unveraendert an
     *  `AutoRefreshImage` durchgereicht (s. dort). */
    anhang?: Attachment | null;
  }>();

  let laeuft = $state(false);

  /** Speichert das Bild lokal: verschlüsselt über `anhangBlob` (Archiv zuerst,
   *  dann Postfach), Klartext via `fetch` auf die Adresse. Das Speichern selbst
   *  macht `dateiTeilenOderLaden` — Share-Sheet in der iOS-WKWebView (dort
   *  funktioniert kein Download-Manager), Anker-Trick auf Desktop. */
  async function herunterladen(): Promise<void> {
    if (laeuft) return;
    laeuft = true;
    try {
      let blob: Blob | null = null;
      if (anhang?.schluessel) {
        const { anhangBlob } = await import('$lib/krypto/anhangHolen');
        blob = await anhangBlob(
          anhang.id,
          anhang.schluessel,
          anhang.mime ?? 'application/octet-stream',
          false
        );
      } else if (src) {
        const antwort = await fetch(src);
        blob = antwort.ok ? await antwort.blob() : null;
      }
      if (!blob) return;
      // Frische Objekt-URL als Brücke zum Blob; sie gehört HIER und wird wie
      // bisher nach der Frist revoket — die Funktion revoket nur ihre eigene
      // Anker-Adresse im Desktop-Fall, nie eine übergebene.
      const adresse = URL.createObjectURL(blob);
      await dateiTeilenOderLaden(adresse, filename || 'bild');
      setTimeout(() => URL.revokeObjectURL(adresse), 10_000);
    } catch {
      // `anhangBlob` kann hier sachlich scheitern (z. B. 410 anhang_abgelaufen
      // — die Kachel zeigt den Grund schon); der Knopf unternimmt still nichts,
      // wie heute bei `blob === null`.
    } finally {
      laeuft = false;
    }
  }
  // ---- Pinch-/Doppeltipp-Zoom (Roadmap 32) -------------------------------
  // Die Rechnung steht geprüft in `lightboxZoom.ts`; hier nur die Gesten.
  // Pointer-Events statt Touch-Events: dieselbe Mechanik trägt Finger, Stift
  // und Maus, und sie ist das, was WebKit und Chromium gemeinsam können.
  let zoom = $state<Zoomstand>({ ...ZOOM_AUS });
  let flaeche = $state<HTMLDivElement | null>(null);
  const zeiger = new Map<number, { x: number; y: number }>();
  // `$state`, weil das Markup sie liest: während einer Geste muss der
  // CSS-Übergang AUS sein, sonst läuft das Bild dem Finger hinterher.
  let pinchBeginn = $state<{ abstand: number; stand: Zoomstand } | null>(null);
  let schiebeVon = $state<{ x: number; y: number; stand: Zoomstand } | null>(null);
  let letzterTipp = 0;

  /** Punkt relativ zur MITTE der Bildfläche — die Bezugsgröße der Rechnung. */
  function zurMitte(x: number, y: number): { x: number; y: number } {
    const r = flaeche?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) };
  }

  function festzurren(stand: Zoomstand): void {
    const r = flaeche?.getBoundingClientRect();
    zoom = begrenzeStand(stand, r?.width ?? 0, r?.height ?? 0);
  }

  function zeigerRunter(e: PointerEvent): void {
    zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zeiger.size === 2) {
      const [a, b] = [...zeiger.values()];
      pinchBeginn = { abstand: Math.hypot(a.x - b.x, a.y - b.y), stand: { ...zoom } };
      schiebeVon = null;
      return;
    }
    if (zeiger.size !== 1) return;
    const jetzt = Date.now();
    // Doppeltipp: zwei Berührungen innerhalb von 300 ms. Kein `dblclick` —
    // das feuert auf Touch unzuverlässig und erst nach Verzögerung.
    if (jetzt - letzterTipp < 300) {
      festzurren(doppeltippStand(zoom));
      letzterTipp = 0;
      return;
    }
    letzterTipp = jetzt;
    if (zoom.skala > 1) schiebeVon = { x: e.clientX, y: e.clientY, stand: { ...zoom } };
  }

  function zeigerBewegt(e: PointerEvent): void {
    if (!zeiger.has(e.pointerId)) return;
    zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchBeginn && zeiger.size === 2) {
      const [a, b] = [...zeiger.values()];
      const abstand = Math.hypot(a.x - b.x, a.y - b.y);
      // Entartete Geste (beide Finger auf einem Punkt): nichts rechnen, sonst
      // entsteht ein NaN-Faktor.
      if (pinchBeginn.abstand <= 0) return;
      const m = zurMitte((a.x + b.x) / 2, (a.y + b.y) / 2);
      festzurren(pinchStand(pinchBeginn.stand, abstand / pinchBeginn.abstand, m.x, m.y));
      return;
    }
    if (!schiebeVon || zeiger.size !== 1) return;
    festzurren({
      skala: schiebeVon.stand.skala,
      dx: schiebeVon.stand.dx + (e.clientX - schiebeVon.x),
      dy: schiebeVon.stand.dy + (e.clientY - schiebeVon.y)
    });
  }

  function zeigerHoch(e: PointerEvent): void {
    zeiger.delete(e.pointerId);
    if (zeiger.size < 2) pinchBeginn = null;
    if (zeiger.size === 0) schiebeVon = null;
  }

  // Beim Schliessen zurücksetzen: das nächste Bild soll nicht im Zoom des
  // vorigen aufgehen.
  $effect(() => {
    if (!open) {
      zoom = { ...ZOOM_AUS };
      zeiger.clear();
      pinchBeginn = null;
      schiebeVon = null;
    }
  });
</script>

<DialogPrimitive.Root bind:open>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      class="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0"
    />
    <DialogPrimitive.Content
      class="fixed inset-4 z-[60] flex items-center justify-center outline-none data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 data-open:zoom-in-95 data-closed:zoom-out-95"
      data-testid="lightbox"
    >
      <DialogPrimitive.Title class="sr-only">
        {filename ?? m.lightbox_image_preview()}
      </DialogPrimitive.Title>

      <!-- Gesten-Fläche. `touch-action: none` ist Pflicht: sonst nimmt der
           Browser Pinch und Wisch selbst entgegen (Seiten-Zoom, Scroll) und
           die Pointer-Events kommen nie an. Die Fläche liegt UNTER den
           Knöpfen (z-Reihenfolge im Markup), damit Schliessen und Speichern
           bedienbar bleiben. -->
      <div
        bind:this={flaeche}
        class="flex h-full w-full touch-none select-none items-center justify-center overflow-hidden"
        role="group"
        aria-label={filename ?? m.lightbox_image_preview()}
        onpointerdown={zeigerRunter}
        onpointermove={zeigerBewegt}
        onpointerup={zeigerHoch}
        onpointercancel={zeigerHoch}
        data-testid="lightbox-zoomflaeche"
      >
        <div
          class="h-full w-full"
          style="transform: translate({zoom.dx}px, {zoom.dy}px) scale({zoom.skala}); transition: {schiebeVon ||
          pinchBeginn
            ? 'none'
            : 'transform 150ms ease-out'};"
        >
          <AutoRefreshImage
            {attachmentId}
            {src}
            {alt}
            {anhang}
            class="pointer-events-none h-full w-full rounded-xl object-contain shadow-2xl"
          />
        </div>
      </div>

      <button
        type="button"
        class="absolute right-16 top-[max(1rem,var(--safe-top))] rounded-full bg-black/60 p-2 text-white hover:bg-black/80 disabled:opacity-50"
        onclick={() => void herunterladen()}
        disabled={laeuft}
        aria-label={m.lightbox_download()}
        title={m.lightbox_download()}
        data-testid="lightbox-download"
      >
        <DownloadIcon class="size-5" />
      </button>

      <DialogPrimitive.Close>
        {#snippet child({ props })}
          <button
            {...props}
            class="absolute right-4 top-[max(1rem,var(--safe-top))] rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
            aria-label={m.lightbox_close()}
            data-testid="lightbox-close"
          >
            <XIcon class="size-5" />
          </button>
        {/snippet}
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>
