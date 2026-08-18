<!--
  Selten gebrauchte Encoder-Schalter, zugeklappt unter dem Start-Knopf.

  **Warum sie nicht mehr oben stehen** (2026-08-18): Intra-Refresh sass als
  Kaestchen direkt zwischen den Feldern, die man beim Streamen wirklich anfasst
  (Quelle, Codec, Bitrate, Bildrate). Es ist aber kein Feld fuer den Alltag —
  seit der Vollbild-Abstand auf 60 s steht, ist die Vorgabe „aus" auch die
  gemessen bessere Wahl (+1,87 VMAF bei 16 % weniger Daten gegenueber
  Intra-Refresh, Tabelle bei `KEYFRAME_SEKUNDEN_VORGABE` im Linux-Sidecar).
  Wer es trotzdem braucht — sehr duenne Leitung, wo die gleichmaessigere
  Verteilung mehr wiegt —, findet es hier.

  **`<details>` statt eines eigenen Aufklapp-Bausteins:** das UI-Kit hat keinen,
  und das Element bringt Tastaturbedienung und Screenreader-Semantik von sich
  aus mit. Eine Nachbildung aus `div` + Zustand waere mehr Code fuer weniger
  Barrierefreiheit.

  Der Zustand wird bewusst NICHT gespeichert: zugeklappt ist der Normalfall, und
  ein aufgeklappt gemerkter Bereich waere genau die Praesenz, die hier weg soll.
-->
<script lang="ts">
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import { streamSettings, persistSettings } from '../settingsState.svelte';
  import { stream } from '../state.svelte';
  import { isLinux, isWindows } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';

  // Zwei Bedingungen, beide notwendig — unveraendert von der frueheren Stelle
  // im `OverridesEditor` uebernommen:
  //
  // Linux ODER Windows: Intra-Refresh setzt den WHIP-Weg voraus, und der
  // braucht einen eigenen WebRTC-Sender (RTCP-Rueckkanal fuer das
  // Einstiegs-Vollbild, dazu ein AV1-Paketierer). macOS bleibt draussen — dort
  // ginge es ueber ffmpegs WHIP-Muxer: kein Rueckkanal, kein AV1, und ein
  // sichtbares Kaestchen waere eine Zusage, die der Sendeweg nicht einloest.
  //
  // Und nur, wenn der Sidecar die Betriebsart wirklich liefert
  // (`health.gsr.intra_refresh`). Beide Sidecars brechen den Start ab, statt
  // still Keyframes zu fahren; ein Kaestchen, dessen Anhaken den Stream
  // scheitern laesst, ist schlechter als keins.
  let zeigen = $derived((isLinux() || isWindows()) && stream.intraRefreshAvailable);

  function onIntraRefresh(e: Event) {
    const an = (e.currentTarget as HTMLInputElement).checked;
    streamSettings.overrides = { ...streamSettings.overrides, intra_refresh: an };
    persistSettings();
  }
</script>

{#if zeigen}
  <details class="group" data-testid="stream-erweitert">
    <summary
      class="text-text-muted hover:text-text-base flex cursor-pointer list-none items-center gap-1.5 text-xs select-none"
    >
      <!-- Dreieck dreht sich beim Aufklappen. `list-none` + eigenes Zeichen,
           weil der eingebaute Marker je nach Browser anders aussieht. -->
      <span class="inline-block transition-transform group-open:rotate-90">▸</span>
      {m.stream_erweitert_titel()}
    </summary>

    <div class="mt-3 flex flex-col gap-2 pl-4">
      <label class="flex cursor-pointer items-start gap-2 text-sm">
        <Checkbox
          class="mt-0.5 shrink-0"
          checked={streamSettings.overrides.intra_refresh === true}
          onchange={onIntraRefresh}
          data-testid="stream-overrides-intra-refresh"
        />
        <span class="flex flex-col">
          <span class="text-text-base">Intra-Refresh</span>
          <span class="text-text-muted text-2xs">{m.stream_erweitert_intra_hinweis()}</span>
        </span>
      </label>
    </div>
  </details>
{/if}
