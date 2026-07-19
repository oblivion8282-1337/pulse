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
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

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

    if (![bMin, bMax].every((v) => Number.isFinite(v) && v >= 1000 && v <= 100000)) {
      toast.error(m.admin_normal_stream_limits_invalid_bitrate(), { description: m.admin_normal_stream_limits_invalid_bitrate_desc() });
      return;
    }
    if (bMin > bMax) {
      toast.error(m.admin_normal_stream_limits_bitrate(), { description: m.admin_normal_stream_limits_min_above_max() });
      return;
    }
    // Screen-share FPS ceiling is 1000 (same wide band as HQ).
    if (![fMin, fMax].every((v) => Number.isInteger(v) && v >= 1 && v <= 1000)) {
      toast.error(m.admin_normal_stream_limits_invalid_fps(), { description: m.admin_normal_stream_limits_invalid_fps_desc() });
      return;
    }
    if (fMin > fMax) {
      toast.error(m.admin_normal_stream_limits_fps(), { description: m.admin_normal_stream_limits_min_above_max() });
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
      toast.success(m.admin_normal_stream_limits_saved());
    } catch (e) {
      toast.error(m.admin_normal_stream_limits_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }

  function resLabel(r: string): string {
    return r === 'native' ? m.admin_normal_stream_limits_native_no_limit() : r;
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-normal-stream-limits">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_normal_stream_limits_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">
      {m.admin_normal_stream_limits_description()}
    </p>
  </div>

  {#if error}
    <FieldError message={m.admin_normal_stream_limits_error({ error })} />
  {:else if current}
    <div class="flex flex-col gap-2">
      <!-- Bitrate -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_normal_stream_limits_bitrate()}</div>
          <div class="text-text-muted text-xs mt-0.5">{m.admin_normal_stream_limits_bitrate_range()}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Input
            type="number" min="1" max="100" step="any"
            bind:value={bitrateMinMbit}
            class="w-20 text-right tabular-nums"
            data-testid="ns-bitrate-min" aria-label={m.admin_normal_stream_limits_bitrate_min_label()}
          />
          <span class="text-text-muted text-xs">{m.admin_normal_stream_limits_to()}</span>
          <Input
            type="number" min="1" max="100" step="any"
            bind:value={bitrateMaxMbit}
            class="w-20 text-right tabular-nums"
            data-testid="ns-bitrate-max" aria-label={m.admin_normal_stream_limits_bitrate_max_label()}
          />
          <span class="text-text-muted text-xs">{m.admin_normal_stream_limits_mbitps()}</span>
        </div>
      </div>

      <!-- FPS -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_normal_stream_limits_fps()}</div>
          <div class="text-text-muted text-xs mt-0.5">{m.admin_normal_stream_limits_fps_range()}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Input
            type="number" min="1" max="1000" step="1"
            bind:value={fpsMin}
            class="w-20 text-right tabular-nums"
            data-testid="ns-fps-min" aria-label={m.admin_normal_stream_limits_fps_min_label()}
          />
          <span class="text-text-muted text-xs">{m.admin_normal_stream_limits_to()}</span>
          <Input
            type="number" min="1" max="1000" step="1"
            bind:value={fpsMax}
            class="w-20 text-right tabular-nums"
            data-testid="ns-fps-max" aria-label={m.admin_normal_stream_limits_fps_max_label()}
          />
          <span class="text-text-muted text-xs">{m.admin_normal_stream_limits_fps_unit()}</span>
        </div>
      </div>

      <!-- Resolution ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_normal_stream_limits_max_resolution()}</div>
          <div class="text-text-muted text-xs mt-0.5">
            {m.admin_normal_stream_limits_max_resolution_desc()}
          </div>
        </div>
        <select
          bind:value={resolutionMax}
          class="w-44 shrink-0 rounded-md border border-border bg-bg-input px-2 py-1 text-sm text-text-bright focus:border-primary focus:outline-none"
          data-testid="ns-resolution-max" aria-label={m.admin_normal_stream_limits_max_resolution()}
        >
          {#each NS_RESOLUTIONS as r (r)}
            <option value={r}>{resLabel(r)}</option>
          {/each}
        </select>
      </div>

      <div class="mt-1 flex justify-end">
        <Button
          size="xs"
          disabled={busy || !dirty}
          onclick={save}
          data-testid="ns-limits-save"
        >
          {busy ? m.admin_normal_stream_limits_saving() : m.admin_normal_stream_limits_save()}
        </Button>
      </div>
    </div>
  {:else}
    <LoadingState label={m.admin_normal_stream_limits_loading()} />
  {/if}
</section>
