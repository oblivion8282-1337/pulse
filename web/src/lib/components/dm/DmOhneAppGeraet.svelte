<!--
  Hinweisbildschirm fuer Direktnachrichten, wenn dieses Konto kein einziges
  App-Geraet hat (Spec §3a, Punkt 1: „Ohne App-Geraet gibt es keine
  Direktnachrichten"). Ersetzt die leere DM-Liste/-Ansicht — eine leere Liste
  waere keine Antwort und erklaerte nichts.

  Ob dieser Bildschirm ueberhaupt gezeigt wird und in WELCHER Auspraegung,
  entscheidet der Aufrufer (`@me/[[dmChannelId]]/+page.svelte`) ueber
  `wandEntscheidung()` (`$lib/krypto/dmOhneAppGeraet.ts`, importfrei geprueft).
  Diese Komponente selbst trifft keine Sichtbarkeits-Entscheidung.

  Zwei Auspraegungen (B11, 2026-09-02):
  * `einrichtung` — App-Kontext (Electron/Android-Huelle): DIESES Geraet kann
    seine Schluessel selbst veroeffentlichen, „Apps herunterladen" waere in
    der App ein Witz. Der Einrichtungslauf wird beim Erscheinen der Wand
    selbst angestossen; der Knopf ist der Handlauf, falls er fehlschlaegt.
  * `apps` — Browser wie bisher: Apps herunterladen / Browser koppeln
    (Regel d4cd6aee — der Browser braucht eine Kopplung, kein Auto-Setup).
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { GERAETE_KOPPLUNG_ENABLED } from '$lib/krypto/schalter';
  import { geraeteEinrichtung } from '$lib/krypto/geraeteEinrichtung.svelte';
  import type { Wandart } from '$lib/krypto/dmOhneAppGeraet';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import LinkIcon from '@lucide/svelte/icons/link';
  import KeyRoundIcon from '@lucide/svelte/icons/key-round';

  let { art }: { art: Exclude<Wandart, 'keine'> } = $props();

  // Der automatische Lauf beim ersten Erscheinen der Wand in App-Kontexten —
  // einmal je Seitenaufruf (`geraeteEinrichtung.ts`), ein Fehlschlag bleibt
  // sichtbar und wartet auf den Knopf, statt sich zu wiederholen.
  $effect(() => {
    if (art === 'einrichtung') geraeteEinrichtung.automatischAnstossen();
  });

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

  {#if art === 'einrichtung'}
    <div class="flex flex-col items-center gap-2">
      {#if geraeteEinrichtung.laeuft}
        <p class="text-text-muted text-sm" data-testid="dm-ohne-app-einrichtung-laeuft">
          {m.dm_ohne_app_einrichtung_laeuft()}
        </p>
      {:else}
        <Button
          type="button"
          size="sm"
          class="gap-1.5"
          onclick={() => void geraeteEinrichtung.starten()}
          data-testid="dm-ohne-app-einrichtung-knopf"
        >
          <KeyRoundIcon class="size-3.5" />
          {m.dm_ohne_app_einrichtung_knopf()}
        </Button>
      {/if}
      {#if geraeteEinrichtung.fehlgeschlagen}
        <p class="text-destructive text-sm" role="alert" data-testid="dm-ohne-app-einrichtung-fehler">
          {m.dm_ohne_app_einrichtung_fehler()}
        </p>
      {/if}
    </div>
  {:else}
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
  {/if}
</section>
