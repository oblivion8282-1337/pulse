<!--
  Global webcam capture ceiling for the LiveKit camera path. Writes the cam_*
  fields on the chat_settings singleton via PATCH /admin/permissions; clients
  pick them up live (capabilities store) and setCamera() sizes its getUserMedia
  capture to the cap. Best-effort / client-enforced (same caveat as the stream
  limits — LiveKit never re-encodes). Resolution stages: 480p/720p/1080p/1440p
  (no 'native' — a webcam has a hardware ceiling). FPS: 15/30/60.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi, type Permissions } from '$lib/api/admin';
  import { m } from '$lib/paraglide/messages.js';

  // Mirrors ALLOWED_CAM_RESOLUTIONS in the backend schema. Ascending for the UI.
  const CAM_RESOLUTIONS = ['480p', '720p', '1080p', '1440p'];
  const CAM_FPS = [15, 30, 60];

  let current = $state<Permissions | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let resolutionMax = $state('720p');
  let fpsMax = $state(30);

  function populate(p: Permissions): void {
    resolutionMax = p.cam_resolution_max;
    fpsMax = p.cam_fps_max;
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
    !!current && (resolutionMax !== current.cam_resolution_max || fpsMax !== current.cam_fps_max)
  );

  async function save() {
    if (!current || busy) return;
    busy = true;
    try {
      current = await adminApi.patchPermissions({
        cam_resolution_max: resolutionMax,
        cam_fps_max: fpsMax
      });
      populate(current);
      toast.success(m.admin_cam_limits_saved());
    } catch (e) {
      toast.error(m.admin_cam_limits_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-cam-limits">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_cam_limits_title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">{m.admin_cam_limits_description()}</p>
    <p class="text-amber-400/80 text-xs mt-1.5" data-testid="cam-limits-advisory">
      {m.admin_cam_limits_advisory()}
    </p>
  </div>

  {#if error}
    <p class="text-red-400 text-sm">{error}</p>
  {:else if current}
    <div class="flex flex-col gap-2">
      <!-- Resolution ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_cam_limits_max_resolution()}</div>
          <div class="text-text-muted text-xs mt-0.5">{m.admin_cam_limits_max_resolution_desc()}</div>
        </div>
        <select
          bind:value={resolutionMax}
          class="w-44 shrink-0 rounded-md border border-border bg-bg-input px-2 py-1 text-sm text-text-bright focus:border-primary focus:outline-none"
          data-testid="cam-resolution-max"
          aria-label={m.admin_cam_limits_max_resolution()}
        >
          {#each CAM_RESOLUTIONS as r (r)}
            <option value={r}>{r}</option>
          {/each}
        </select>
      </div>

      <!-- FPS ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_cam_limits_max_fps()}</div>
          <div class="text-text-muted text-xs mt-0.5">{m.admin_cam_limits_max_fps_desc()}</div>
        </div>
        <select
          bind:value={fpsMax}
          class="w-44 shrink-0 rounded-md border border-border bg-bg-input px-2 py-1 text-sm text-text-bright focus:border-primary focus:outline-none"
          data-testid="cam-fps-max"
          aria-label={m.admin_cam_limits_max_fps()}
        >
          {#each CAM_FPS as f (f)}
            <option value={f}>{f}</option>
          {/each}
        </select>
      </div>

      <div class="mt-1 flex justify-end">
        <button
          type="button"
          disabled={busy || !dirty}
          onclick={save}
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          data-testid="cam-limits-save"
        >
          {busy ? m.admin_cam_limits_saving() : m.admin_cam_limits_save()}
        </button>
      </div>
    </div>
  {:else}
    <div class="text-text-muted text-sm">{m.admin_cam_limits_loading()}</div>
  {/if}
</section>
