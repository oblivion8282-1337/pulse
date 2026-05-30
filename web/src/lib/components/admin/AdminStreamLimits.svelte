<!--
  Global HQ-stream quality limits. Writes the hq_* fields on the chat_settings
  singleton via PATCH /admin/permissions; every client picks them up live
  (capabilities store) and the HQ stream panel clamps to them.

  Best-effort: media-svc/MediaMTX never see the actual stream params (no
  transcoding), so these are enforced client-side — same as the long-standing
  bitrate cap. Honest note shown to the admin below.

  Bitrate is shown in Mbit/s (friendlier than kbps); stored as kbps.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi, type Permissions } from '$lib/api/admin';
  import { RESOLUTION_VALUES } from '$lib/stream/settings.svelte';

  let current = $state<Permissions | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // Working copy. Bitrate in Mbit/s for the UI; fps raw; resolution string.
  let bitrateMinMbit = $state<number | ''>('');
  let bitrateMaxMbit = $state<number | ''>('');
  let fpsMin = $state<number | ''>('');
  let fpsMax = $state<number | ''>('');
  let resolutionMax = $state('Native');

  function populate(p: Permissions): void {
    bitrateMinMbit = p.hq_bitrate_min_kbps / 1000;
    bitrateMaxMbit = p.hq_bitrate_max_kbps / 1000;
    fpsMin = p.hq_fps_min;
    fpsMax = p.hq_fps_max;
    resolutionMax = p.hq_resolution_max;
  }

  onMount(async () => {
    try {
      current = await adminApi.getPermissions();
      populate(current);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  const dirty = $derived(
    !!current &&
      (Math.round(Number(bitrateMinMbit) * 1000) !== current.hq_bitrate_min_kbps ||
        Math.round(Number(bitrateMaxMbit) * 1000) !== current.hq_bitrate_max_kbps ||
        Number(fpsMin) !== current.hq_fps_min ||
        Number(fpsMax) !== current.hq_fps_max ||
        resolutionMax !== current.hq_resolution_max)
  );

  async function save() {
    if (!current || busy) return;
    const bMin = Math.round(Number(bitrateMinMbit) * 1000);
    const bMax = Math.round(Number(bitrateMaxMbit) * 1000);
    const fMin = Number(fpsMin);
    const fMax = Number(fpsMax);

    // Mirror the backend bounds so the toast explains the problem before the
    // round-trip. Bitrate 0.1–32 Mbit/s (100–32000 kbps), FPS 1–360.
    if (![bMin, bMax].every((v) => Number.isFinite(v) && v >= 100 && v <= 32000)) {
      toast.error('Ungültige Bitrate', { description: 'Bitte 0,1 – 32 Mbit/s.' });
      return;
    }
    if (bMin > bMax) {
      toast.error('Bitrate', { description: 'Minimum darf nicht über dem Maximum liegen.' });
      return;
    }
    if (![fMin, fMax].every((v) => Number.isInteger(v) && v >= 1 && v <= 360)) {
      toast.error('Ungültige FPS', { description: 'Bitte ganze Zahl 1 – 360.' });
      return;
    }
    if (fMin > fMax) {
      toast.error('FPS', { description: 'Minimum darf nicht über dem Maximum liegen.' });
      return;
    }

    busy = true;
    try {
      current = await adminApi.patchPermissions({
        hq_bitrate_min_kbps: bMin,
        hq_bitrate_max_kbps: bMax,
        hq_fps_min: fMin,
        hq_fps_max: fMax,
        hq_resolution_max: resolutionMax
      });
      populate(current);
      toast.success('Streaming-Limits gespeichert');
    } catch (e) {
      toast.error('Speichern fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }

  function resLabel(r: string): string {
    return r === 'Native' ? 'Native (kein Limit)' : r;
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-stream-limits">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">Streaming-Limits (HQ)</h2>
    <p class="text-text-muted text-xs mt-0.5">
      Grenzen für HQ-Desktop-Streams (Bitrate, FPS, Auflösung). Greifen in der App —
      der Server wandelt Streams nicht um, daher Best-Effort (wie das bisherige Bitrate-Limit).
      Standard = keine echte Einschränkung.
    </p>
  </div>

  {#if error}
    <p class="text-red-400 text-sm">Fehler: {error}</p>
  {:else if current}
    <div class="flex flex-col gap-2">
      <!-- Bitrate -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">Bitrate</div>
          <div class="text-text-muted text-xs mt-0.5">Erlaubter Bereich in Mbit/s (0,1 – 32).</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            type="number" min="0.1" max="32" step="0.5"
            bind:value={bitrateMinMbit}
            class="w-20 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="hq-bitrate-min" aria-label="Bitrate Minimum (Mbit/s)"
          />
          <span class="text-text-muted text-xs">bis</span>
          <input
            type="number" min="0.1" max="32" step="0.5"
            bind:value={bitrateMaxMbit}
            class="w-20 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="hq-bitrate-max" aria-label="Bitrate Maximum (Mbit/s)"
          />
          <span class="text-text-muted text-xs">Mbit/s</span>
        </div>
      </div>

      <!-- FPS -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">Bildrate (FPS)</div>
          <div class="text-text-muted text-xs mt-0.5">Erlaubter Bereich an Bildern pro Sekunde (1 – 360).</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            type="number" min="1" max="360" step="1"
            bind:value={fpsMin}
            class="w-20 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="hq-fps-min" aria-label="FPS Minimum"
          />
          <span class="text-text-muted text-xs">bis</span>
          <input
            type="number" min="1" max="360" step="1"
            bind:value={fpsMax}
            class="w-20 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="hq-fps-max" aria-label="FPS Maximum"
          />
          <span class="text-text-muted text-xs">FPS</span>
        </div>
      </div>

      <!-- Resolution ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">Maximale Auflösung</div>
          <div class="text-text-muted text-xs mt-0.5">
            Höchste erlaubte Auflösung. Höhere Stufen (und „Native") werden im Stream-Panel ausgeblendet.
          </div>
        </div>
        <select
          bind:value={resolutionMax}
          class="w-44 shrink-0 rounded-md border border-border bg-bg-input px-2 py-1 text-sm text-text-bright focus:border-primary focus:outline-none"
          data-testid="hq-resolution-max" aria-label="Maximale Auflösung"
        >
          {#each RESOLUTION_VALUES as r (r)}
            <option value={r}>{resLabel(r)}</option>
          {/each}
        </select>
      </div>

      <div class="mt-1 flex justify-end">
        <button
          type="button"
          disabled={busy || !dirty}
          onclick={save}
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          data-testid="hq-limits-save"
        >
          {busy ? 'Speichere…' : 'Speichern'}
        </button>
      </div>
    </div>
  {:else}
    <div class="text-text-muted text-sm">lade…</div>
  {/if}
</section>
