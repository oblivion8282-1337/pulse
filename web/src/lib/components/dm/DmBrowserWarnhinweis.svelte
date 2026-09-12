<!--
  Einmaliger Warnhinweis ueber den Direktnachrichten, wenn dieses Konto ein
  reines Browser-Konto ohne verbundene Sicherung ist (Aufhebung der
  Koexistenz-Regel, 2026-09-12): Die Nachrichten liegen E2E-verschluesselt
  nur auf den Geraeten — und dieser Browser ist das einzige. Sichtbarkeit
  und Wegklicken entscheidet `krypto/dmBrowserWarnung.svelte.ts`; diese
  Komponente trifft keine Sichtbarkeitsentscheidung.

  Der Text fasst seit gleichem Datum auch den Frischgeraet-Hinweis der
  Sicherung zusammen („frühere Nachrichten liegen im Archiv"): Zeigt dieser
  Banner, unterbleibt das `SicherungHinweis`-Feld im Chat unten — dieselbe
  Auskunft und derselbe Knopf zweimal waeren Rauschen. Ohne Banner (Konto
  MIT haltbarem Geraet) bleibt das Feld wie bisher.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { dmBrowserWarnung } from '$lib/krypto/dmBrowserWarnung.svelte';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import XIcon from '@lucide/svelte/icons/x';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  // Auf dem Handy sind Einstellungen eigene Routen (`/app/me/[section]`),
  // am Desktop ein Dialog mit Reiter — dasselbe Muster wie ueberall sonst,
  // wo aus dem @me-Bereich in die Einstellungen verzweigt wird.
  function zuEinstellungen(tab: 'apps' | 'sicherung') {
    if (viewport.isMobile) {
      void goto(`/app/me/${tab}`);
    } else {
      uiOverlays.openSettings(tab);
    }
  }
</script>

{#if dmBrowserWarnung.zeigt()}
  <section
    class="glass-panel flex flex-col items-start gap-2 rounded-2xl border border-amber-500/30 p-4 text-sm"
    data-testid="dm-browser-warnhinweis"
  >
    <div class="flex w-full items-start gap-2">
      <TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div class="min-w-0 flex-1">
        <p class="font-semibold">{m.dm_browser_warnung_titel()}</p>
        <p class="text-text-muted">{m.dm_browser_warnung_text()}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={m.dm_browser_warnung_weg()}
        onclick={() => dmBrowserWarnung.wegklicken()}
        data-testid="dm-browser-warnhinweis-weg"
      >
        <XIcon class="size-4" />
      </Button>
    </div>
    <div class="flex flex-wrap gap-2 pl-6">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        class="gap-1.5"
        onclick={() => zuEinstellungen('apps')}
        data-testid="dm-browser-warnhinweis-app"
      >
        <DownloadIcon class="size-3.5" />
        {m.dm_browser_warnung_app_knopf()}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        class="gap-1.5"
        onclick={() => zuEinstellungen('sicherung')}
        data-testid="dm-browser-warnhinweis-laufwerk"
      >
        <CloudIcon class="size-3.5" />
        {m.dm_browser_warnung_laufwerk_knopf()}
      </Button>
    </div>
  </section>
{/if}
