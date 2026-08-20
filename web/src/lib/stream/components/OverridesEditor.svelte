<!--
  OverridesEditor — die zentralen Stream-Einstellungen: Codec, Auflösung,
  Bitrate, FPS. (Hieß historisch "Overrides", weil es früher Profile gab; die
  sind raus — diese vier Werte gehen jetzt direkt an den Encoder.)

  Validierung: Bitrate `HQ_BITRATE_MIN_KBPS`–`HQ_BITRATE_MAX_KBPS` (Cap gegen
  VPS-Bandbreiten-Saturation), FPS aus `FPS_VALUES` (Stufen-Dropdown; bei
  10 bit zusätzlich die Last-Grenze `HQ_TEN_BIT_MAX_PIXELS_PER_SEC`, s.
  `settingsCatalog`), Auflösung aus dem festen Set, Codec aus `CODEC_VALUES`.
-->
<script lang="ts">
  import { Label } from '$lib/components/ui/label/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import Checkbox from '$lib/components/form/Checkbox.svelte';
  import {
    streamSettings,
    VIDEO_MODES,
    videoModeOf,
    applyVideoMode,
    av1Nutzbar,
    allowedResolutions,
    clampResolution,
    captureSourceForSlot,
    persistSettings,
    FPS_STANDARD,
    allowedFpsSteps,
    fpsAllowed,
    snapFps,
  } from '../settings.svelte';
  import { stream } from '../state.svelte';
  import { sourceSize, resolutionOptions, RESOLUTION_BOXES, fitWithinBox } from '../resolution';
  import { effectiveHqLimits } from '../guildLimits';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { isWindows } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';

  // Slot, dessen Quelle die Auflösungs-Stufen filtert. Von außen `streamSlot`,
  // weil `slot` ein reservierter Svelte-Attributname ist (wie `MonitorPicker`).
  // `channelId` = der Ziel-Voice-Kanal; über ihn kennen wir die wirksamen
  // Grenzen DIESER Community (nicht nur die Instanz-Defaults).
  let { channelId = null, streamSlot: slot = 0 }: {
    channelId?: string | null;
    streamSlot?: number;
  } = $props();

  // Nur anbieten, was diese Maschine wirklich encodieren kann UND was heil
  // beim Zuschauer ankommt. AV1 verlangt, dass der Sidecar es in
  // `video_codecs` meldet (RTX 40xx, neuere Intel/AMD) — auf macOS zusaetzlich,
  // dass der Sendeweg es traegt, und das tut er dort nicht (`av1Nutzbar`, seit
  // 2026-08-19: ffmpegs WHIP-Muxer kennt kein AV1, der M3+ bekam still H.264).
  // H.264 ist die Grundlinie und steht immer da. 10 bit verlangt
  // zusätzlich `health.gsr.ten_bit` — es hängt am Encoder, nicht am Codec.
  //
  // Ein nicht angebotener Eintrag ist besser als ein angebotener, der beim
  // Start still zurückgenommen wird: der Nutzer sähe sonst „AV1 10 bit" im Feld
  // und bekäme 8 bit, ohne dass irgendwo etwas dazu steht.
  //
  // HDR hat zusätzlich zwei eigene Bedingungen: die Maschine muss es tragen
  // (`health.gsr.hdr` — belegt für AV1 über AMF auf AMD und AV1 über NVENC auf
  // NVIDIA; hier stand bis zum 2026-08-11 „allein AV1 über AMF auf AMD") und es
  // gibt den Weg nur unter Windows. Fehlt eines, taucht der Eintrag gar nicht
  // erst auf — dieselbe Regel wie oben, nur eine Zeile tiefer.
  let codecOptions = $derived(
    VIDEO_MODES.filter(
      (m) =>
        (m.codec !== 'av1' || av1Nutzbar(streamSettings.gpu_info?.video_codecs)) &&
        (!m.tenBit || stream.tenBitAvailable) &&
        (!m.hdr || (isWindows() && stream.hdrAvailable)),
    ),
  );

  // Wirksame Grenzen DIESER Community (Wert der Community ?? Instanz-Default),
  // nicht die Instanz-Werte direkt: sonst böte der Editor eine Auswahl an, die
  // der Stream-Start (`buildStartArgs`) hinterher still wegklemmt — genau die
  // verwirrende Diskrepanz. Die Obergrenzen kommen von hier, die Untergrenzen
  // bleiben instanzweit (ein Min ist keine Community-Grenze). Live, weil
  // `effectiveHqLimits` den reaktiven Guild-Store liest.
  let hq = $derived(effectiveHqLimits(channelId));
  let bMin = $derived(capabilities.hqBitrateMinKbps);
  let bMax = $derived(hq.bitrateMaxKbps);
  let fMin = $derived(capabilities.hqFpsMin);
  let fMax = $derived(hq.fpsMax);
  // Größe der gewählten Quelle (null = unbekannt, z.B. Linux-Portal); bestimmt
  // Filterung und Beschriftung der Auflösungs-Stufen — s. `resolution.ts`.
  let srcSize = $derived(
    sourceSize(captureSourceForSlot(slot), {
      monitors: streamSettings.available_monitors,
      windows: streamSettings.available_windows,
    }),
  );
  let resOptions = $derived(
    resolutionOptions(
      allowedResolutions(hq.resolutionMax),
      srcSize,
      m.overrides_editor_resolution_native(),
    ),
  );

  function onCodec(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value || 'h264';
    streamSettings.overrides = applyVideoMode(streamSettings.overrides, v);
    persistSettings();
  }

  // Hard cap on input (snap the field down so the user can't go above max),
  // enforce the minimum on blur (clamping the min *while* typing would turn a
  // half-typed "2" into the floor). Both write the field's DOM value directly
  // so the displayed number can never exceed the admin ceiling.
  function onBitrate(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') {
      streamSettings.overrides = { ...streamSettings.overrides, bitrate_kbps: undefined };
      persistSettings();
      return;
    }
    let n = parseInt(el.value, 10);
    if (isNaN(n)) return;
    if (n > bMax) {
      n = bMax;
      el.value = String(n);
    }
    streamSettings.overrides = { ...streamSettings.overrides, bitrate_kbps: n };
    persistSettings();
  }

  function onBitrateBlur(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') return;
    const n = parseInt(el.value, 10);
    if (isNaN(n)) {
      el.value = '';
      return;
    }
    const clamped = Math.min(bMax, Math.max(bMin, n));
    el.value = String(clamped);
    streamSettings.overrides = { ...streamSettings.overrides, bitrate_kbps: clamped };
    persistSettings();
  }

  // Bildrate: Auswahl aus Stufen statt Freifeld (`FPS_VALUES`). Kein
  // „Eigener Wert"-Eintrag — ein Freifeld unterliefe genau die Führung, um
  // die es hier geht (nicht anbieten ist besser als hinten wegklemmen).
  function onFpsSelect(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    const next = { ...streamSettings.overrides };
    // '' = „Standard": das Feld ungesetzt lassen, der Sidecar nimmt seine
    // Vorgabe (60). `delete` wie bei `bit_depth` — ein `fps: undefined`
    // schleppfe sich durch jede persistierte Einstellung.
    if (v === '') delete next.fps;
    else next.fps = Number(v);
    streamSettings.overrides = next;
    persistSettings();
  }

  function onResolution(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value || 'Native';
    streamSettings.overrides = { ...streamSettings.overrides, resolution: v };
    persistSettings();
  }

  // Der ANGEZEIGTE Wert muss in der Optionsliste vorkommen — wie bei der
  // Auflösung unten. Sonst zeigt das Feld „AV1 10 bit" auf einer Maschine, die
  // das gar nicht anbietet (gespeicherte Wahl von einem anderen Rechner).
  let codecValue = $derived.by(() => {
    const gewuenscht = videoModeOf(streamSettings.overrides);
    return codecOptions.some((o) => o.value === gewuenscht) ? gewuenscht : 'h264';
  });
  // 10 bit schliesst Browser-Zuschauer aus — das muss beim EINSTELLEN dastehen,
  // nicht erst beim Zuschauer.
  //
  // Warum: Chromes Hardware-Decoder steigt bei 10-bit-AV1 mitten im Strom aus
  // und faellt auf `dav1d` zurueck, der kein 10 bit kann; danach ist der Strom
  // fuer diesen Zuschauer endgueltig undekodierbar (gemessen 2026-08-01,
  // `streaming/testbench/profiles/browser-2026-08-01-windows-av1-10bit.json`).
  // Der Zuschauer lehnt seit dem 2026-08-05 ausdruecklich ab, statt einzufrieren
  // (`hqStreamManager.svelte.ts`) — aber die Wahl faellt HIER, und wer sie
  // trifft, soll ihre Folge kennen, statt sie beim Publikum zu entdecken.
  //
  // Ein Hinweis und keine Sperre: wer nur Desktop-Zuschauer hat, bekommt mit
  // 10 bit das bessere Bild, und diese Entscheidung gehoert dem Streamer.
  const zehnBitGewaehlt = $derived(
    VIDEO_MODES.find((v) => v.value === codecValue)?.tenBit === true,
  );
  let bitrateValue = $derived(streamSettings.overrides.bitrate_kbps ?? '');
  // Der *angezeigte* Wert muss in der Optionsliste vorkommen — sonst zeigt das
  // Select einen Wert an, den es nicht mehr gibt. Zwei Gründe, warum er fehlen
  // kann: das Admin-Limit (deckelt auf z.B. 1080p) und der Quellen-Filter
  // (gespeichert '4K', Quelle 1440p). Dann fällt die Anzeige auf 'Native' —
  // ehrlich, denn beides sendet dieselbe Größe. Gespeichert bleibt der alte
  // Wert: wechselt der User auf einen 4K-Monitor, ist seine Wahl wieder da.
  let resValue = $derived.by(() => {
    const clamped = clampResolution(
      streamSettings.overrides.resolution ?? 'Native',
      hq.resolutionMax,
    );
    return resOptions.some((o) => o.value === clamped) ? clamped : 'Native';
  });

  // Die Größe, die bei der gewählten Auflösung tatsächlich hinausgeht — sie
  // begrenzt bei 10 bit die Bildraten-Stufen (Last-Regel, `settingsCatalog`).
  // Ohne bekannte Quellgröße gilt die Stufen-BOX als obere Schranke: die
  // Einpassung verkleinert nur, macht nie größer — die Box ist der Worst Case.
  let sendGroesse = $derived.by(() => {
    if (resValue === 'Native') return srcSize;
    const box = RESOLUTION_BOXES[resValue];
    if (!box) return null;
    if (!srcSize) return { width: box[0], height: box[1] };
    return fitWithinBox(srcSize.width, srcSize.height, box[0], box[1]);
  });
  let fpsOptions = $derived(allowedFpsSteps(zehnBitGewaehlt, sendGroesse, fMin, fMax));
  // „Standard" wird wie eine Stufe geprüft und nicht durchgewinkt — wäre die
  // Vorgabe (60) in der Kombination nicht erlaubt, fällt der Eintrag weg
  // (Begründung an `FPS_STANDARD`). Sonst wäre die Vorgabe der einzige Weg,
  // die Last-Grenze unbemerkt zu unterlaufen.
  let standardErlaubt = $derived(fpsAllowed(FPS_STANDARD, zehnBitGewaehlt, sendGroesse, fMin, fMax));
  // Der wirksame Wert des Felds: die gespeicherte Wahl, oder ohne eine solche
  // „Standard" — außer die Vorgabe ist in der Kombination gerade nicht
  // erlaubt, dann steht sie selbst an (und wird vom Effect unten festgenagelt).
  // `null` heißt „Standard": das Feld bleibt ungesetzt, der Sidecar nimmt 60.
  let fpsAktuell = $derived(
    streamSettings.overrides.fps ?? (standardErlaubt ? null : FPS_STANDARD),
  );
  // Der ANGEZEIGTE Wert kommt immer aus der Liste (oder ist „Standard"): ein
  // Wert außerhalb der Liste wird auf die nächste Stufe gebogen (`snapFps`
  // gibt einen bereits enthaltenen unverändert zurück) — die Anzeige zeigt
  // nie etwas, das nicht gesendet würde. Das Zurückschreiben macht der $Effect.
  let fpsValue = $derived(fpsAktuell === null ? '' : String(snapFps(fpsAktuell, fpsOptions)));

  // Weggefallene Stufen nicht nur anders ANZEIGEN, sondern auch so speichern:
  // `buildStartArgs` schickt den gespeicherten Wert, und der soll nicht
  // heimlich etwas senden, was das Feld gar nicht mehr anbietet. Das Biegen
  // ist sichtbar (das Feld springt auf den neuen Wert), nie laut — der
  // Wechsel der Kombination ist selbst die Nutzerhandlung.
  $effect(() => {
    if (fpsAktuell === null || fpsOptions.includes(fpsAktuell)) return;
    streamSettings.overrides = { ...streamSettings.overrides, fps: snapFps(fpsAktuell, fpsOptions) };
    persistSettings();
  });

  function onShowCursor(e: Event) {
    streamSettings.show_cursor = (e.currentTarget as HTMLInputElement).checked;
    persistSettings();
  }

  // Die Bittiefe hatte hier bis zum 2026-08-02 ein eigenes Kästchen, das bei
  // falschem Codec gesperrt danebenstand. Sie steckt jetzt im Codec-Feld
  // (`VIDEO_MODES`): 10 bit gibt es ohnehin nur mit AV1, und zwei gekoppelte
  // Bedienelemente zu erklären ist mehr Aufwand als eine Liste, in der die
  // unmögliche Kombination gar nicht vorkommt.
</script>

<div class="flex flex-col gap-3" data-testid="stream-overrides-editor">
 <!-- `h-6` = Höhe der Kopfzeile der Quellenauswahl links; die wird dort vom
      Refresh-Knopf (Button size="xs") aufgespannt. Ohne die feste Höhe säße
      „Video" rund 4 px höher als „Quelle", weil hier kein Knopf danebensteht. -->
 <div class="flex h-6 items-center"><Label>Video</Label></div>
 <div class="grid gap-3 sm:grid-cols-2">
  <div class="flex flex-col gap-1.5">
    <Label for="ov-codec" class="text-text-muted text-2xs font-semibold tracking-wide uppercase">Codec</Label>
    <select
      id="ov-codec"
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
      value={codecValue}
      onchange={onCodec}
      data-testid="stream-overrides-codec"
    >
      {#each codecOptions as c (c.value)}
        <option value={c.value}>{c.label}</option>
      {/each}
    </select>
    {#if zehnBitGewaehlt}
      <p class="text-2xs text-amber-500" data-testid="stream-overrides-ten-bit-warning">
        {m.overrides_editor_ten_bit_warning()}
      </p>
    {/if}
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-resolution" class="text-text-muted text-2xs font-semibold tracking-wide uppercase">{m.overrides_editor_resolution_label()}</Label>
    <select
      id="ov-resolution"
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
      value={resValue}
      onchange={onResolution}
      data-testid="stream-overrides-resolution"
    >
      {#each resOptions as r (r.value)}
        <option value={r.value}>{r.label}</option>
      {/each}
    </select>
    <!-- Bei bekannter Quellgröße sagen die Beschriftungen schon alles — der
         allgemeine Hinweis entfällt dann. Die Admin-Deckelung wird immer
         gezeigt, sie erklärt eine Einschränkung von außen. -->
    {#if hq.resolutionMax !== 'Native'}
      <p class="text-text-muted text-2xs">
        {m.overrides_editor_resolution_capped({ max: hq.resolutionMax })}
      </p>
    {:else if !srcSize}
      <p class="text-text-muted text-2xs">{m.overrides_editor_resolution_hint()}</p>
    {/if}
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-bitrate" class="text-text-muted text-2xs font-semibold tracking-wide uppercase">{m.overrides_editor_bitrate_label()}</Label>
    <Input
      id="ov-bitrate"
      class="tabular-nums"
      type="number"
      min={bMin}
      max={bMax}
      step="500"
      placeholder={m.overrides_editor_bitrate_placeholder()}
      value={bitrateValue}
      oninput={onBitrate}
      onblur={onBitrateBlur}
      data-testid="stream-overrides-bitrate"
    />
    <p class="text-text-muted text-2xs">{m.overrides_editor_bitrate_range({ min: bMin, max: bMax })}</p>
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="ov-fps" class="text-text-muted text-2xs font-semibold tracking-wide uppercase">FPS</Label>
    <select
      id="ov-fps"
      class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
      value={fpsValue}
      onchange={onFpsSelect}
      data-testid="stream-overrides-fps"
    >
      {#if standardErlaubt}
        <option value="">{m.overrides_editor_fps_standard()}</option>
      {/if}
      {#each fpsOptions as f (f)}
        <option value={String(f)}>{f}</option>
      {/each}
    </select>
    <!-- Solange die Last-Grenze etwas streicht, wäre die Bereichsangabe
         „Erlaubt: 1–144" daneben aktiv irreführend — die Liste endet ja
         sichtbar früher. Dann sagt der Hinweis, WER die Auswahl begrenzt. -->
    {#if zehnBitGewaehlt && sendGroesse}
      <p class="text-text-muted text-2xs">{m.overrides_editor_fps_capped()}</p>
    {:else}
      <p class="text-text-muted text-2xs">{m.overrides_editor_fps_range({ min: fMin, max: fMax })}</p>
    {/if}
  </div>
 </div>

  <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
    <!-- **Das Intra-Refresh-Kaestchen sass bis zum 2026-08-18 hier.** Es steht
         jetzt zugeklappt unter dem Start-Knopf (`ErweiterteOptionen.svelte`) —
         zwischen Quelle, Codec, Bitrate und Bildrate gehoert es nicht hin: das
         sind die Felder fuer den Alltag, Intra-Refresh ist es nicht. Die beiden
         Bedingungen (nur Linux/Windows, nur wenn der Sidecar es meldet) sind
         mitgewandert und dort begruendet. -->


    <!-- HIER STAND BIS ZUM 2026-08-07 EIN HDR-KAESTCHEN. Es sitzt jetzt als
         vierter Eintrag im Codec-Feld oben („AV1 10 bit HDR", `VIDEO_MODES`),
         weil es beim Anhaken ohnehin das Codec-Feld umstellen musste — HDR gibt
         es nur mit 10 bit. Dieselbe Auflösung wie bei der Bittiefe am
         2026-08-02, und aus demselben Grund.

         Die Bedingungen sind mitgewandert und unveraendert: nur Windows, und
         nur wenn der Sidecar es meldet (`health.gsr.hdr` — belegt fuer AV1
         ueber AMF auf AMD und AV1 ueber NVENC auf NVIDIA; hier stand bis zum
         2026-08-11 „allein AV1 ueber AMF auf AMD"). Linux und macOS koennen die Aufnahme
         heute nicht in 16-Bit-Fliesskomma holen, dort gaebe es nichts zu senden.

         **Der Eintrag haengt bewusst NICHT daran, ob HDR in Windows gerade
         eingeschaltet ist.** Waere es so, verschwaende er beim Ausschalten
         spurlos, und niemand kaeme auf den Zusammenhang. Der Sidecar sagt beim
         Start klar, dass der Schirm in SDR laeuft, und nennt den Windows-
         Schalter — das ist die Stelle, an der die Auskunft ankommt. -->
    <label class="flex cursor-pointer items-center gap-2 text-sm">
      <Checkbox
        checked={streamSettings.show_cursor}
        onchange={onShowCursor}
        data-testid="stream-overrides-show-cursor"
      />
      <span class="text-text-base">{m.overrides_editor_show_cursor()}</span>
    </label>
  </div>
</div>
