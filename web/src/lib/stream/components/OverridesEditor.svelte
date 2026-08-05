<!--
  OverridesEditor — die zentralen Stream-Einstellungen: Codec, Auflösung,
  Bitrate, FPS. (Hieß historisch "Overrides", weil es früher Profile gab; die
  sind raus — diese vier Werte gehen jetzt direkt an den Encoder.)

  Validierung: Bitrate `HQ_BITRATE_MIN_KBPS`–`HQ_BITRATE_MAX_KBPS` (Cap gegen
  VPS-Bandbreiten-Saturation), FPS 1–360, Auflösung aus dem festen Set,
  Codec aus `CODEC_VALUES`.
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
    gpuHasAv1,
    allowedResolutions,
    clampResolution,
    captureSourceForSlot,
    persistSettings,
  } from '../settings.svelte';
  import { stream } from '../state.svelte';
  import { sourceSize, resolutionOptions } from '../resolution';
  import { effectiveHqLimits } from '../guildLimits';
  import { capabilities } from '$lib/stores/capabilities.svelte';
  import { isLinux, isWindows } from '$lib/platform/runtime';
  import { m } from '$lib/paraglide/messages.js';

  // Slot, dessen Quelle die Auflösungs-Stufen filtert. Von außen `streamSlot`,
  // weil `slot` ein reservierter Svelte-Attributname ist (wie `MonitorPicker`).
  // `channelId` = der Ziel-Voice-Kanal; über ihn kennen wir die wirksamen
  // Grenzen DIESER Community (nicht nur die Instanz-Defaults).
  let { channelId = null, streamSlot: slot = 0 }: {
    channelId?: string | null;
    streamSlot?: number;
  } = $props();

  // Nur anbieten, was diese Maschine wirklich encodieren kann. AV1 verlangt,
  // dass der Sidecar es in `video_codecs` meldet (RTX 40xx, neuere Intel/AMD,
  // Apple M3+); H.264 ist die Grundlinie und steht immer da. 10 bit verlangt
  // zusätzlich `health.gsr.ten_bit` — es hängt am Encoder, nicht am Codec.
  //
  // Ein nicht angebotener Eintrag ist besser als ein angebotener, der beim
  // Start still zurückgenommen wird: der Nutzer sähe sonst „AV1 10 bit" im Feld
  // und bekäme 8 bit, ohne dass irgendwo etwas dazu steht.
  let codecOptions = $derived(
    VIDEO_MODES.filter(
      (m) =>
        (m.codec !== 'av1' || gpuHasAv1(streamSettings.gpu_info?.video_codecs)) &&
        (!m.tenBit || stream.tenBitAvailable),
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

  function onIntraRefresh(e: Event) {
    const an = (e.currentTarget as HTMLInputElement).checked;
    streamSettings.overrides = { ...streamSettings.overrides, intra_refresh: an };
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

  function onFps(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') {
      streamSettings.overrides = { ...streamSettings.overrides, fps: undefined };
      persistSettings();
      return;
    }
    let n = parseInt(el.value, 10);
    if (isNaN(n)) return;
    if (n > fMax) {
      n = fMax;
      el.value = String(n);
    }
    streamSettings.overrides = { ...streamSettings.overrides, fps: n };
    persistSettings();
  }

  function onFpsBlur(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    if (el.value === '') return;
    const n = parseInt(el.value, 10);
    if (isNaN(n)) {
      el.value = '';
      return;
    }
    const clamped = Math.min(fMax, Math.max(fMin, n));
    el.value = String(clamped);
    streamSettings.overrides = { ...streamSettings.overrides, fps: clamped };
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
  let bitrateValue = $derived(streamSettings.overrides.bitrate_kbps ?? '');
  let fpsValue = $derived(streamSettings.overrides.fps ?? '');
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
    <Input
      id="ov-fps"
      class="tabular-nums"
      type="number"
      min={fMin}
      max={fMax}
      step="1"
      placeholder={m.overrides_editor_fps_placeholder()}
      value={fpsValue}
      oninput={onFps}
      onblur={onFpsBlur}
      data-testid="stream-overrides-fps"
    />
    <p class="text-text-muted text-2xs">{m.overrides_editor_fps_range({ min: fMin, max: fMax })}</p>
  </div>
 </div>

  <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
    <!-- Zwei Bedingungen, beide notwendig.

         Linux ODER Windows: Intra-Refresh setzt den WHIP-Weg voraus, und der
         braucht einen eigenen WebRTC-Sender (RTCP-Rueckkanal fuer das
         Einstiegs-Vollbild, dazu ein AV1-Paketierer). Den hatte lange nur der
         Linux-Sidecar; seit dem 2026-08-04 hat ihn der Windows-Sidecar auch
         (`win-hq-sidecar/src/whip/`, dieselbe Fassung). macOS bleibt draussen —
         dort ginge es weiter ueber ffmpegs WHIP-Muxer: kein Rueckkanal, kein
         AV1, und ein sichtbares Kaestchen waere eine Zusage, die der Sendeweg
         nicht einloest.

         Und nur, wenn der Sidecar die Betriebsart wirklich liefert — was
         `health.gsr.intra_refresh` meldet. Die Frage dahinter ist je Plattform
         eine andere: auf Linux, ob das FFmpeg die VAAPI-Option durchreicht
         (nur mit unserem Patch); auf Windows, ob der Encoder, der bei dieser
         Karte WIRKLICH laeuft, sie traegt — auf AMD ist das AV1 ueber AMF,
         nicht H.264 ueber D3D12. Beide Sidecars brechen den Start ab, statt
         still Keyframes zu fahren; ein Kaestchen, dessen Anhaken den Stream
         scheitern laesst, ist schlechter als keins. Dieselbe Begruendung wie
         beim Codec-Feld oben. -->
    {#if (isLinux() || isWindows()) && stream.intraRefreshAvailable}
      <label class="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox
          checked={streamSettings.overrides.intra_refresh === true}
          onchange={onIntraRefresh}
          data-testid="stream-overrides-intra-refresh"
        />
        <span class="text-text-base">Intra-Refresh</span>
      </label>
    {/if}

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
