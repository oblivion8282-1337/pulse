<!--
  SettingsStandplatzProfil — womit dieser Rechner überträgt, wenn er aus der
  Ferne geweckt wird.

  **Warum das nicht die normalen Stream-Einstellungen sind:** bis zu den
  Standplatz-Geräten galt „wer überträgt, entscheidet", und das war richtig,
  solange „wer entscheidet" und „wer sitzt davor" dieselbe Person waren. Hier
  fallen die Rollen auseinander — entschieden hat der Besitzer irgendwann,
  gebraucht wird das Bild von jemand anderem. Ohne dieses Profil startete ein
  geweckter Rechner mit dem, was zuletzt von Hand eingestellt war, im
  schlimmsten Fall „4K, 60 fps, HDR" vom Vorführen: die schlechteste denkbare
  Einstellung zum Fernsteuern.

  Die Begründung jeder einzelnen Vorgabe steht in
  `$lib/devices/profil.svelte.ts` — kurz: Auflösung nativ (Schrift muss lesbar
  sein), lieber 30 Bilder als 60 (halb so viele Bilder heisst doppelt so viele
  Bits je Bild), H.264 (läuft überall und hat als einziger Weg einen
  Rückkanal), Hauptbildschirm statt eines gemerkten Monitors.

  Die Community-Grenzen klemmen weiterhin darüber — das Profil ist ein Wunsch
  nach unten, keine Umgehung (`buildStartArgs`).
-->
<script lang="ts">
  import SlidersIcon from '@lucide/svelte/icons/sliders-horizontal';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import {
    standplatzProfil,
    HAUPTBILDSCHIRM,
    VORGABE,
    type StandplatzProfil,
  } from '$lib/devices/profil.svelte';
  import { streamSettings } from '$lib/stream/settings.svelte';
  import { MONITOR_CAPTURE_PREFIX, RESOLUTION_VALUES } from '$lib/stream/settingsCatalog';
  import { m } from '$lib/paraglide/messages.js';

  // Entwurf im Formular, „Speichern" schreibt fest — wie bei der Dauerfreigabe
  // nebenan. Ein Profil, das sich beim Tippen ändert, gälte schon für den
  // nächsten Weckruf, während man noch die Bitrate sucht.
  let entwurf = $state<StandplatzProfil>({ ...standplatzProfil.profil });

  const monitore = $derived(streamSettings.available_monitors);

  function zuruecksetzen(): void {
    entwurf = { ...VORGABE };
  }
</script>

<div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
  <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
    <SlidersIcon class="size-4" />
    {m.standplatz_profil_title()}
  </span>
  <span class="text-text-muted text-xs">{m.standplatz_profil_hint()}</span>

  <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.standplatz_profil_source()}</span>
      <select
        class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
        bind:value={entwurf.quelle}
        data-testid="standplatz-profil-quelle"
      >
        <option value={HAUPTBILDSCHIRM}>{m.standplatz_profil_source_primary()}</option>
        {#each monitore as mon (mon.index)}
          <option value={`${MONITOR_CAPTURE_PREFIX}${mon.index}`}>
            {mon.name} ({mon.width}×{mon.height})
          </option>
        {/each}
      </select>
      <span class="text-text-muted text-xs">{m.standplatz_profil_source_hint()}</span>
    </label>

    <div class="grid grid-cols-2 gap-2">
      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs">{m.standplatz_profil_codec()}</span>
        <select
          class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
          bind:value={entwurf.codec}
          data-testid="standplatz-profil-codec"
        >
          <option value="h264">H.264</option>
          <option value="av1">AV1</option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs">{m.standplatz_profil_resolution()}</span>
        <select
          class="border-border bg-bg-input text-text-bright rounded-lg border px-2 py-1.5 text-sm"
          bind:value={entwurf.aufloesung}
          data-testid="standplatz-profil-aufloesung"
        >
          {#each RESOLUTION_VALUES as r (r)}
            <option value={r}>{r}</option>
          {/each}
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs">{m.standplatz_profil_fps()}</span>
        <Input type="number" min="10" max="120" bind:value={entwurf.fps} data-testid="standplatz-profil-fps" />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs">{m.standplatz_profil_bitrate()}</span>
        <Input
          type="number"
          min="1000"
          max="10000"
          step="500"
          bind:value={entwurf.bitrate_kbps}
          data-testid="standplatz-profil-bitrate"
        />
      </label>
    </div>

    <span class="text-text-muted text-xs">{m.standplatz_profil_no_hdr()}</span>

    <div class="flex justify-end gap-2 pt-1">
      <Button size="sm" variant="ghost" onclick={zuruecksetzen}>
        {m.standplatz_profil_reset()}
      </Button>
      <Button onclick={() => standplatzProfil.setzen(entwurf)} data-testid="standplatz-profil-save">
        {m.standplatz_profil_save()}
      </Button>
    </div>
  </div>
</div>
