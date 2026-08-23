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
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import Select from '$lib/components/form/Select.svelte';
  import { stream } from '$lib/stream/state.svelte';
  import {
    standplatzProfil,
    HAUPTBILDSCHIRM,
    VORGABE,
    type StandplatzProfil,
  } from '$lib/devices/profil.svelte';
  import { streamSettings } from '$lib/stream/settings.svelte';
  import { MONITOR_CAPTURE_PREFIX, RESOLUTION_VALUES } from '$lib/stream/settingsCatalog';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Entwurf im Formular, „Speichern" schreibt fest — wie bei der Dauerfreigabe
  // nebenan. Ein Profil, das sich beim Tippen ändert, gälte schon für den
  // nächsten Weckruf, während man noch die Bitrate sucht.
  let entwurf = $state<StandplatzProfil>({ ...standplatzProfil.profil });

  const monitore = $derived(streamSettings.available_monitors);

  /**
   * Die Bildraten-Grenzen kommen aus den **Streaming-Einstellungen des
   * Betreibers**, nicht aus dieser Datei.
   *
   * **Hier stand bis zum 2026-08-23 eine feste 120**, ohne Begründung und im
   * Widerspruch zum regulären Weg. Der erste Versuch, das zu beheben, ersetzte
   * sie durch eine feste 144 aus der Stufenliste — und war derselbe Fehler in
   * neuem Anstrich: eine Obergrenze im Client, wo eine Grenze des Betreibers
   * hingehört. Wer eine Grenze setzen darf, ist eine Rechtefrage, keine
   * Geschmacksfrage.
   *
   * Die Untergrenze bleibt instanzweit, die Obergrenze ebenso — anders als im
   * regulären Editor wird hier **nicht** die Community-Grenze genommen: ein
   * Standplatz-Gerät kann seine Community wechseln (seit 2026-08-20), das
   * Profil hängt aber am Gerät. Die Community-Grenze klemmt ohnehin beim Start
   * (`buildStartArgs`) — das Profil ist ein Wunsch, keine Umgehung.
   */
  const fpsMin = $derived(capabilities.hqFpsMin);
  const fpsMax = $derived(capabilities.hqFpsMax);

  /**
   * Alte Auswahl nachziehen: wer früher den primären Schirm über seine Nummer
   * gewählt hat, trägt jetzt denselben Eintrag unter dem Wert „Hauptbildschirm".
   * Ohne diese Zeile stünde das Feld leer, weil kein Eintrag den alten Wert hat.
   */
  $effect(() => {
    const primaer = monitore.find((mon) => mon.primary);
    if (primaer && entwurf.quelle === `${MONITOR_CAPTURE_PREFIX}${primaer.index}`) {
      entwurf = { ...entwurf, quelle: HAUPTBILDSCHIRM };
    }
  });

  /**
   * 10 bit gibt es nur mit AV1 und nur, wenn der Sidecar es meldet; HDR nur
   * obendrauf. Beides hängt am **Entwurf**, nicht am gespeicherten Profil —
   * wer im Formular auf H.264 stellt, sieht die Kästchen sofort ausgrauen,
   * statt erst nach dem Speichern zu merken, dass es nicht zusammengeht.
   */
  const zehnBitMoeglich = $derived(entwurf.codec === 'av1' && stream.tenBitAvailable);
  const hdrMoeglich = $derived(zehnBitMoeglich && entwurf.zehn_bit && stream.hdrAvailable);

  /**
   * Eine Zahl aus einem Zahlenfeld, geklemmt — und mit Vorgabe für „nichts".
   *
   * **Der Fehlerfall** (Bughunt 2026-08-16): ein geleertes `<input
   * type="number">` schreibt über `bind:value` ein `null`. Das ging so in den
   * Speicher, und beim nächsten Start verwarf `profil.svelte.ts` es wieder
   * (dort gilt nur eine Zahl > 0) — die Einstellung war nach einem Neustart
   * still auf die Vorgabe zurückgesprungen. Dazwischen ging ein `fps: null` in
   * die Startargumente eines geweckten Rechners, den niemand beaufsichtigt.
   *
   * Geklemmt statt abgelehnt: die Grenzen stehen als `min`/`max` an den
   * Feldern, aber ein Browser erzwingt sie ausserhalb eines `<form>` nicht.
   */
  function zahl(wert: unknown, vorgabe: number, min: number, max: number): number {
    const n = typeof wert === 'number' ? wert : Number(wert);
    if (!Number.isFinite(n) || n <= 0) return vorgabe;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  /**
   * **Ein Eintrag je Schirm, der primäre trägt den Stern.** Vorher stand
   * „Hauptbildschirm" zusätzlich in der Liste, und derselbe Monitor
   * erschien darunter noch einmal mit seinem Namen — doppelt gemoppelt.
   * Zusammengelegt heisst: wer den markierten wählt, wählt „der jeweils
   * primäre" (Wert [`HAUPTBILDSCHIRM`]). Das ist auf einem
   * unbeaufsichtigten Rechner die haltbarere Zusage: wird umgesteckt
   * oder der primäre Schirm gewechselt, folgt die Aufnahme, statt auf
   * eine Nummer zu zeigen, die es vielleicht nicht mehr gibt.
   * Ohne gemeldete Liste (nie verbunden) bleibt der eine Ersatz-Eintrag.
   */
  const quellOptionen = $derived([
    ...(monitore.length === 0
      ? [{ value: HAUPTBILDSCHIRM, label: m.standplatz_profil_source_primary() }]
      : []),
    ...monitore.map((mon) => ({
      value: mon.primary ? HAUPTBILDSCHIRM : `${MONITOR_CAPTURE_PREFIX}${mon.index}`,
      label: `${mon.primary ? '* ' : ''}${mon.name} (${mon.width}×${mon.height})`,
    })),
  ]);

  // Statische Listen ohne m.*-Aufruf — einmal berechnet als const, kein
  // `$derived` (das wäre eine Ableitung ohne Abhängigkeit).
  const codecOptionen = [
    { value: 'h264', label: 'H.264' },
    { value: 'av1', label: 'AV1' },
  ];
  const aufloesungOptionen = RESOLUTION_VALUES.map((r) => ({ value: r, label: r }));

  function speichern(): void {
    entwurf = {
      ...entwurf,
      fps: zahl(entwurf.fps, VORGABE.fps, fpsMin, fpsMax),
      bitrate_kbps: zahl(entwurf.bitrate_kbps, VORGABE.bitrate_kbps, 1000, 10000),
    };
    void standplatzProfil.setzen(entwurf);
  }
</script>

<div class="border-border flex flex-col gap-3 rounded-2xl border p-4">
  <span class="text-text-bright flex items-center gap-2 text-sm font-semibold">
    <SlidersIcon class="size-4" />
    {m.standplatz_profil_title()}
  </span>

  <div class="border-border/60 flex flex-col gap-2 border-t pt-3">
    <label class="flex flex-col gap-1">
      <span class="text-text-muted text-xs">{m.standplatz_profil_source()}</span>
      <Select
        value={entwurf.quelle}
        options={quellOptionen}
        onchange={(v) => (entwurf = { ...entwurf, quelle: v })}
        data-testid="standplatz-profil-quelle"
      />
    </label>

    <div class="grid grid-cols-2 gap-2">
      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs">{m.standplatz_profil_codec()}</span>
        <Select
          value={entwurf.codec}
          options={codecOptionen}
          onchange={(v) => (entwurf = { ...entwurf, codec: v as 'h264' | 'av1' })}
          data-testid="standplatz-profil-codec"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs">{m.standplatz_profil_resolution()}</span>
        <Select
          value={entwurf.aufloesung}
          options={aufloesungOptionen}
          onchange={(v) => (entwurf = { ...entwurf, aufloesung: v })}
          data-testid="standplatz-profil-aufloesung"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="text-text-muted text-xs">{m.standplatz_profil_fps()}</span>
        <Input
          type="number"
          min={fpsMin}
          max={fpsMax}
          bind:value={entwurf.fps}
          data-testid="standplatz-profil-fps"
        />
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


    <!-- Die drei Schalter nebeneinander: sie gehören zusammen (was der
         Encoder zusätzlich tun soll) und kosten einzeln untereinander mehr
         Höhe als der ganze Rest des Bildes. -->
    <div class="border-border/60 flex flex-wrap items-start gap-x-6 gap-y-2 border-t pt-3">
      <label class="flex items-start gap-2">
        <Checkbox
        class="mt-0.5 shrink-0"
        bind:checked={entwurf.zehn_bit}
        disabled={!zehnBitMoeglich}
        data-testid="standplatz-profil-zehnbit"
        />
        <span class="text-text-bright text-sm font-medium">{m.standplatz_profil_ten_bit()}</span>
      </label>
      <label class="flex items-start gap-2">
        <Checkbox
        class="mt-0.5 shrink-0"
        bind:checked={entwurf.hdr}
        disabled={!hdrMoeglich}
        data-testid="standplatz-profil-hdr"
        />
        <span class="text-text-bright text-sm font-medium">{m.standplatz_profil_hdr()}</span>
      </label>
    </div>

    <div class="flex justify-end gap-2 pt-1">
      <Button onclick={speichern} data-testid="standplatz-profil-save">
        {m.standplatz_profil_save()}
      </Button>
    </div>
  </div>
</div>
