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
  import { Button } from '$lib/components/ui/button';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import Select from '$lib/components/form/Select.svelte';

  // Mirrors ALLOWED_CAM_RESOLUTIONS in the backend schema. Ascending for the UI.
  const CAM_RESOLUTIONS = ['480p', '720p', '1080p', '1440p'];
  const CAM_FPS = [15, 30, 60];

  // Beide Felder arbeiten mit String-Werten (Auswahlliste); die FPS-Zahl
  // wird beim Setzen zurückgeparsst — `fpsMax` bleibt eine Zahl wie bisher.
  const resOptionen = CAM_RESOLUTIONS.map((r) => ({ value: r, label: r }));
  const fpsOptionen = CAM_FPS.map((f) => ({ value: String(f), label: String(f) }));

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
    <p class="text-warning/80 text-xs mt-1.5" data-testid="cam-limits-advisory">
      {m.admin_cam_limits_advisory()}
    </p>
  </div>

  {#if error}
    <FieldError message={error} />
  {:else if current}
    <div class="flex flex-col gap-2">
      <!-- Resolution ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_cam_limits_max_resolution()}</div>
          <div class="text-text-muted text-xs mt-0.5">{m.admin_cam_limits_max_resolution_desc()}</div>
        </div>
        <Select
          class="w-44 shrink-0"
          value={resolutionMax}
          options={resOptionen}
          onchange={(v) => (resolutionMax = v)}
          data-testid="cam-resolution-max"
          aria-label={m.admin_cam_limits_max_resolution()}
        />
      </div>

      <!-- FPS ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{m.admin_cam_limits_max_fps()}</div>
          <div class="text-text-muted text-xs mt-0.5">{m.admin_cam_limits_max_fps_desc()}</div>
        </div>
        <Select
          class="w-44 shrink-0"
          value={String(fpsMax)}
          options={fpsOptionen}
          onchange={(v) => (fpsMax = Number(v))}
          data-testid="cam-fps-max"
          aria-label={m.admin_cam_limits_max_fps()}
        />
      </div>

      <div class="mt-1 flex justify-end">
        <Button
          size="xs"
          disabled={busy || !dirty}
          onclick={save}
          data-testid="cam-limits-save"
        >
          {busy ? m.admin_cam_limits_saving() : m.admin_cam_limits_save()}
        </Button>
      </div>
    </div>
  {:else}
    <LoadingState label={m.admin_cam_limits_loading()} />
  {/if}
</section>
