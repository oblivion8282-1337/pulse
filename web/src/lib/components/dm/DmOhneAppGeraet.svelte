<!--
  Hinweisbildschirm fuer Direktnachrichten, wenn dieses Konto kein einziges
  App-Geraet hat (Spec §3a, Punkt 1: „Ohne App-Geraet gibt es keine
  Direktnachrichten"). Ersetzt die leere DM-Liste/-Ansicht — eine leere Liste
  waere keine Antwort und erklaerte nichts.

  Ob dieser Bildschirm ueberhaupt gezeigt wird, entscheidet der Aufrufer
  (`@me/[[dmChannelId]]/+page.svelte`) ueber `dmOhneAppGeraet()`
  (`$lib/krypto/dmOhneAppGeraet.ts`, importfrei geprueft). Diese Komponente
  selbst trifft keine Sichtbarkeits-Entscheidung.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { GERAETE_KOPPLUNG_ENABLED } from '$lib/krypto/schalter';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import LinkIcon from '@lucide/svelte/icons/link';

  // Auf dem Handy sind Einstellungen eigene Routen (`/app/me/[section]`),
  // am Desktop ein Dialog mit Reiter — dasselbe Muster wie ueberall sonst,
  // wo aus dem @me-Bereich in die Einstellungen verzweigt wird.
  function zuEinstellungen(tab: 'apps' | 'security') {
    if (viewport.isMobile) {
      void goto(`/app/me/${tab}`);
    } else {
      uiOverlays.openSettings(tab);
    }
  }
</script>

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-none p-8 text-center md:rounded-2xl"
  data-testid="dm-ohne-app-geraet"
>
  <p class="text-text-bright text-base font-semibold">{m.dm_ohne_app_title()}</p>
  <p class="text-text-muted max-w-sm text-sm">{m.dm_ohne_app_was_ist()}</p>
  <p class="text-text-muted max-w-sm text-sm">{m.dm_ohne_app_was_fehlt()}</p>

  <div class="flex flex-wrap justify-center gap-2">
    <Button
      type="button"
      size="sm"
      class="gap-1.5"
      onclick={() => zuEinstellungen('apps')}
      data-testid="dm-ohne-app-apps-knopf"
    >
      <DownloadIcon class="size-3.5" />
      {m.dm_ohne_app_apps_knopf()}
    </Button>
    {#if GERAETE_KOPPLUNG_ENABLED}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        class="gap-1.5"
        onclick={() => zuEinstellungen('security')}
        data-testid="dm-ohne-app-kopplung-knopf"
      >
        <LinkIcon class="size-3.5" />
        {m.dm_ohne_app_kopplung_knopf()}
      </Button>
    {/if}
  </div>

  {#if GERAETE_KOPPLUNG_ENABLED}
    <p class="text-text-muted max-w-sm text-xs">{m.dm_ohne_app_kopplung_hinweis()}</p>
  {/if}
</section>
