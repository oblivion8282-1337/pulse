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
  import { RESOLUTION_VALUES } from '$lib/stream/settingsCatalog';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

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
    // round-trip. Bitrate 1–100 Mbit/s (1000–100000 kbps), FPS 1–1000.
    if (![bMin, bMax].every((v) => Number.isFinite(v) && v >= 1000 && v <= 100000)) {
      toast.error(m.admin_stream_limits_toast_bitrate_invalid(), { description: m.admin_stream_limits_toast_bitrate_invalid_desc() });
      return;
    }
    if (bMin > bMax) {
      toast.error(m.admin_stream_limits_toast_bitrate_label(), { description: m.admin_stream_limits_toast_min_over_max() });
      return;
    }
    if (![fMin, fMax].every((v) => Number.isInteger(v) && v >= 1 && v <= 1000)) {
      toast.error(m.admin_stream_limits_toast_fps_invalid(), { description: m.admin_stream_limits_toast_fps_invalid_desc() });
      return;
    }
    if (fMin > fMax) {
      toast.error(m.admin_stream_limits_toast_fps_label(), { description: m.admin_stream_limits_toast_min_over_max() });
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
      toast.success(m.admin_stream_limits_toast_saved());
    } catch (e) {
      toast.error(m.admin_stream_limits_toast_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }

  function resLabel(r: string): string {
    return r === 'Native' ? m.admin_stream_limits_resolution_native() : r;
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-stream-limits">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_stream_limits_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">
      {m.admin_stream_limits_description()}
    </p>
  </div>

  {#if error}
    <FieldError message={m.admin_stream_limits_error({ error: error ?? '' })} />
  {:else if current}
    <div class="flex flex-col gap-2">
      <!-- Bitrate -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_stream_limits_bitrate_label()}</div>
          <div class="text-text-muted text-xs mt-0.5">{m.admin_stream_limits_bitrate_hint()}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Input
            type="number" min="1" max="100" step="any"
            bind:value={bitrateMinMbit}
            class="w-20 text-right tabular-nums"
            data-testid="hq-bitrate-min" aria-label={m.admin_stream_limits_bitrate_min_aria()}
          />
          <span class="text-text-muted text-xs">{m.admin_stream_limits_to()}</span>
          <Input
            type="number" min="1" max="100" step="any"
            bind:value={bitrateMaxMbit}
            class="w-20 text-right tabular-nums"
            data-testid="hq-bitrate-max" aria-label={m.admin_stream_limits_bitrate_max_aria()}
          />
          <span class="text-text-muted text-xs">{m.admin_stream_limits_mbit_unit()}</span>
        </div>
      </div>

      <!-- FPS -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_stream_limits_fps_label()}</div>
          <div class="text-text-muted text-xs mt-0.5">{m.admin_stream_limits_fps_hint()}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Input
            type="number" min="1" max="1000" step="1"
            bind:value={fpsMin}
            class="w-20 text-right tabular-nums"
            data-testid="hq-fps-min" aria-label={m.admin_stream_limits_fps_min_aria()}
          />
          <span class="text-text-muted text-xs">{m.admin_stream_limits_to()}</span>
          <Input
            type="number" min="1" max="1000" step="1"
            bind:value={fpsMax}
            class="w-20 text-right tabular-nums"
            data-testid="hq-fps-max" aria-label={m.admin_stream_limits_fps_max_aria()}
          />
          <span class="text-text-muted text-xs">{m.admin_stream_limits_fps_unit()}</span>
        </div>
      </div>

      <!-- Resolution ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_stream_limits_resolution_label()}</div>
          <div class="text-text-muted text-xs mt-0.5">
            {m.admin_stream_limits_resolution_hint()}
          </div>
        </div>
        <select
          bind:value={resolutionMax}
          class="w-44 shrink-0 rounded-md border border-border bg-bg-input px-2 py-1 text-sm text-text-bright focus:border-primary focus:outline-none"
          data-testid="hq-resolution-max" aria-label={m.admin_stream_limits_resolution_aria()}
        >
          {#each RESOLUTION_VALUES as r (r)}
            <option value={r}>{resLabel(r)}</option>
          {/each}
        </select>
      </div>

      <div class="mt-1 flex justify-end">
        <Button
          size="xs"
          disabled={busy || !dirty}
          onclick={save}
          data-testid="hq-limits-save"
        >
          {busy ? m.admin_stream_limits_saving() : m.admin_stream_limits_save()}
        </Button>
      </div>
    </div>
  {:else}
    <LoadingState label={m.admin_stream_limits_loading()} />
  {/if}
</section>
