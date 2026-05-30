<!--
  Global limits for the *normal* browser screen-share path (LiveKit), separate
  from the HQ limits (AdminStreamLimits). Writes the ns_* fields on the
  chat_settings singleton via PATCH /admin/permissions; clients pick them up
  live and the screen-share settings + publish path clamp to them.

  Best-effort / client-enforced (same caveat as HQ). Bitrate shown in Mbit/s
  (stored kbps). Resolution set: native (no cap) / 1080p / 720p / 480p.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi, type Permissions } from '$lib/api/admin';

  // Screen-share resolution ceiling options (descending; 'native' = no cap).
  const NS_RESOLUTIONS = ['native', '1080p', '720p', '480p'];

  let current = $state<Permissions | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let bitrateMinMbit = $state<number | ''>('');
  let bitrateMaxMbit = $state<number | ''>('');
  let fpsMin = $state<number | ''>('');
  let fpsMax = $state<number | ''>('');
  let resolutionMax = $state('native');

  function populate(p: Permissions): void {
    bitrateMinMbit = p.ns_bitrate_min_kbps / 1000;
    bitrateMaxMbit = p.ns_bitrate_max_kbps / 1000;
    fpsMin = p.ns_fps_min;
    fpsMax = p.ns_fps_max;
    resolutionMax = p.ns_resolution_max;
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
      (Math.round(Number(bitrateMinMbit) * 1000) !== current.ns_bitrate_min_kbps ||
        Math.round(Number(bitrateMaxMbit) * 1000) !== current.ns_bitrate_max_kbps ||
        Number(fpsMin) !== current.ns_fps_min ||
        Number(fpsMax) !== current.ns_fps_max ||
        resolutionMax !== current.ns_resolution_max)
  );

  async function save() {
    if (!current || busy) return;
    const bMin = Math.round(Number(bitrateMinMbit) * 1000);
    const bMax = Math.round(Number(bitrateMaxMbit) * 1000);
    const fMin = Number(fpsMin);
    const fMax = Number(fpsMax);

    if (![bMin, bMax].every((v) => Number.isFinite(v) && v >= 100 && v <= 32000)) {
      toast.error('Ungültige Bitrate', { description: 'Bitte 0,1 – 32 Mbit/s.' });
      return;
    }
    if (bMin > bMax) {
      toast.error('Bitrate', { description: 'Minimum darf nicht über dem Maximum liegen.' });
      return;
    }
    // Screen-share FPS ceiling is 240.
    if (![fMin, fMax].every((v) => Number.isInteger(v) && v >= 1 && v <= 240)) {
      toast.error('Ungültige FPS', { description: 'Bitte ganze Zahl 1 – 240.' });
      return;
    }
    if (fMin > fMax) {
      toast.error('FPS', { description: 'Minimum darf nicht über dem Maximum liegen.' });
      return;
    }

    busy = true;
    try {
      current = await adminApi.patchPermissions({
        ns_bitrate_min_kbps: bMin,
        ns_bitrate_max_kbps: bMax,
        ns_fps_min: fMin,
        ns_fps_max: fMax,
        ns_resolution_max: resolutionMax
      });
      populate(current);
      toast.success('Limits fürs normale Streaming gespeichert');
    } catch (e) {
      toast.error('Speichern fehlgeschlagen', {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }

  function resLabel(r: string): string {
    return r === 'native' ? 'Native (kein Limit)' : r;
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-normal-stream-limits">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">Streaming-Limits (Normal)</h2>
    <p class="text-text-muted text-xs mt-0.5">
      Grenzen für das normale Streaming (Browser-Bildschirm-Share) — getrennt von den HQ-Limits.
      Greifen in der App (Best-Effort). Standard = keine echte Einschränkung.
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
            data-testid="ns-bitrate-min" aria-label="Bitrate Minimum (Mbit/s)"
          />
          <span class="text-text-muted text-xs">bis</span>
          <input
            type="number" min="0.1" max="32" step="0.5"
            bind:value={bitrateMaxMbit}
            class="w-20 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="ns-bitrate-max" aria-label="Bitrate Maximum (Mbit/s)"
          />
          <span class="text-text-muted text-xs">Mbit/s</span>
        </div>
      </div>

      <!-- FPS -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">Bildrate (FPS)</div>
          <div class="text-text-muted text-xs mt-0.5">Erlaubter Bereich an Bildern pro Sekunde (1 – 240).</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            type="number" min="1" max="240" step="1"
            bind:value={fpsMin}
            class="w-20 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="ns-fps-min" aria-label="FPS Minimum"
          />
          <span class="text-text-muted text-xs">bis</span>
          <input
            type="number" min="1" max="240" step="1"
            bind:value={fpsMax}
            class="w-20 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="ns-fps-max" aria-label="FPS Maximum"
          />
          <span class="text-text-muted text-xs">FPS</span>
        </div>
      </div>

      <!-- Resolution ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">Maximale Auflösung</div>
          <div class="text-text-muted text-xs mt-0.5">
            Höchste erlaubte Auflösung. Höhere Stufen (und „Native") werden im Share-Menü ausgeblendet.
          </div>
        </div>
        <select
          bind:value={resolutionMax}
          class="w-44 shrink-0 rounded-md border border-border bg-bg-input px-2 py-1 text-sm text-text-bright focus:border-primary focus:outline-none"
          data-testid="ns-resolution-max" aria-label="Maximale Auflösung"
        >
          {#each NS_RESOLUTIONS as r (r)}
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
          data-testid="ns-limits-save"
        >
          {busy ? 'Speichere…' : 'Speichern'}
        </button>
      </div>
    </div>
  {:else}
    <div class="text-text-muted text-sm">lade…</div>
  {/if}
</section>
