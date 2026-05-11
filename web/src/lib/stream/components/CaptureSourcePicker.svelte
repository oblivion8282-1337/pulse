<!--
  CaptureSourcePicker — wählt "portal" oder einen konkreten Monitor.

  HDR-Warnung übernommen aus `ui/stream_window.py::_refresh_codec_warning`:
  HDR-Codecs (Ende `_hdr`) funktionieren nicht mit Portal-Capture, dort
  bekommt GSR keinen direkten Display-Handle. Wenn der User HDR im
  OverridesEditor wählt UND auf Portal steht, blenden wir die Warnung ein
  und schlagen einen Monitor vor.
-->
<script lang="ts">
  import { Label } from '$lib/components/ui/label/index.js';
  import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
  import { streamSettings, isHdrCodec, currentProfile } from '../settings.svelte';

  let effectiveCodec = $derived.by(() => {
    if (streamSettings.use_overrides && streamSettings.overrides.codec) {
      return streamSettings.overrides.codec;
    }
    return currentProfile()?.codec;
  });
  let hdrPortalConflict = $derived(
    isHdrCodec(effectiveCodec) && streamSettings.capture_source === 'portal',
  );
</script>

<div class="flex flex-col gap-1.5" data-testid="stream-capture-picker">
  <Label for="stream-capture-select">Capture-Quelle</Label>
  <select
    id="stream-capture-select"
    class="bg-bg-input text-text-base h-9 rounded-md px-2 text-sm outline-none"
    value={streamSettings.capture_source}
    onchange={(e) => (streamSettings.capture_source = (e.currentTarget as HTMLSelectElement).value)}
    data-testid="stream-capture-select"
  >
    <option value="portal">Portal — Wayland fragt beim Start (universell)</option>
    {#each streamSettings.available_monitors as m (m.name)}
      <option value={m.name}>{m.name} · {m.resolution}</option>
    {/each}
  </select>

  {#if streamSettings.available_monitors.length === 0}
    <p class="text-text-muted text-xs">
      Direkte Monitor-Liste leer (im Sandbox normal — dort geht nur Portal).
    </p>
  {/if}

  {#if hdrPortalConflict}
    <div
      class="flex items-start gap-2 rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
      role="alert"
      data-testid="stream-capture-hdr-warning"
    >
      <AlertTriangleIcon class="mt-0.5 size-4 shrink-0" />
      <span>
        HDR funktioniert nicht mit Portal-Capture. Wähle einen direkten Monitor
        (z.B. DP-1) oder schalte HDR im Codec ab.
      </span>
    </div>
  {/if}
</div>
