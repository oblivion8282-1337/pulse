<!--
  Vorerklärung vor einem System-Berechtigungs-Dialog (iOS-Liste Punkt 36).

  **Warum es diesen Zwischenschritt gibt.** Ein System-Dialog für Mitteilungen,
  Mikrofon oder Kamera erscheint auf iOS GENAU EINMAL. Ein „nein" dort ist
  dauerhaft — der nächste Versuch kommt ohne Dialog zurück, und der Weg zurück
  führt in die System-Einstellungen. Pulse fragte die Mitteilungs-Erlaubnis
  bisher BEIM START ab, bevor der Nutzer die App gesehen hat: der schlechteste
  Augenblick, den es gibt, weil es dort keinen Grund für ein Ja gibt.

  Wann das Blatt erscheint, entscheidet `platform/berechtigungRegel.ts`
  (geprüft) — nicht diese Komponente.

  Durch ein `Portal`: `position: fixed` bezieht sich nicht aufs Fenster, sobald
  ein Vorfahre `backdrop-filter` hat, und `glass-panel` hat genau das (am
  Profil-Blatt nachgemessen, s. CLAUDE.md). Hier steht es am Wurzelknoten des
  Layouts, der Portal ist also Vorsorge gegen eine künftige Verschiebung —
  billiger als der Fehler, den er verhindert.
-->
<script lang="ts">
  import { Portal } from 'bits-ui';
  import BellIcon from '@lucide/svelte/icons/bell';
  import CameraIcon from '@lucide/svelte/icons/camera';
  import MicIcon from '@lucide/svelte/icons/mic';
  import { Button } from '$lib/components/ui/button';
  import { m } from '$lib/paraglide/messages.js';
  import { berechtigungsblatt } from '$lib/platform/berechtigung.svelte';

  const art = $derived(berechtigungsblatt.offen);

  const texte = $derived.by(() => {
    switch (art) {
      case 'mitteilungen':
        return {
          titel: m.berechtigung_mitteilungen_titel(),
          text: m.berechtigung_mitteilungen_text(),
          Symbol: BellIcon
        };
      case 'mikrofon':
        return {
          titel: m.berechtigung_mikrofon_titel(),
          text: m.berechtigung_mikrofon_text(),
          Symbol: MicIcon
        };
      case 'kamera':
        return {
          titel: m.berechtigung_kamera_titel(),
          text: m.berechtigung_kamera_text(),
          Symbol: CameraIcon
        };
      default:
        return null;
    }
  });
</script>

{#if texte}
  {@const Symbol = texte.Symbol}
  <Portal>
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 nicht-handy:p-4">
      <div
        class="bg-bg-panel border-border w-full max-w-md rounded-t-2xl border p-5 shadow-2xl nicht-handy:rounded-2xl"
        style="padding-bottom: calc(1.25rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))"
        role="dialog"
        aria-modal="true"
        aria-label={texte.titel}
        data-testid="berechtigung-vorerklaerung"
        data-art={art}
      >
        <div class="flex items-start gap-3">
          <div class="bg-primary/15 text-primary flex size-10 shrink-0 items-center justify-center rounded-full">
            <Symbol class="size-5" />
          </div>
          <div class="min-w-0">
            <h2 class="text-text text-base font-semibold">{texte.titel}</h2>
            <p class="text-text-muted mt-1 text-sm">{texte.text}</p>
          </div>
        </div>
        <div class="mt-5 flex flex-col gap-2">
          <Button
            class="min-h-12 w-full"
            onclick={() => berechtigungsblatt.antworten(true)}
            data-testid="berechtigung-weiter"
          >
            {m.berechtigung_weiter()}
          </Button>
          <Button
            variant="ghost"
            class="min-h-12 w-full"
            onclick={() => berechtigungsblatt.antworten(false)}
            data-testid="berechtigung-spaeter"
          >
            {m.berechtigung_spaeter()}
          </Button>
        </div>
      </div>
    </div>
  </Portal>
{/if}
