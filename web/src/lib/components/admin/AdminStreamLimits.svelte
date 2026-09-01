<!--
  Global stream quality limits, parameterised for BOTH value sets that live on
  the chat_settings singleton (PATCH /admin/permissions):
    - prefix="hq": HQ-stream limits (hq_* fields), resolutions = RESOLUTION_VALUES
    - prefix="ns": normal browser screen-share limits (ns_* fields)
  Every client picks the values up live (capabilities store) and clamps to
  them. Best-effort: media-svc/MediaMTX never see the actual stream params (no
  transcoding), so these are enforced client-side — honest note in the copy.

  Bitrate is shown in Mbit/s (friendlier than kbps); stored as kbps. All labels
  come in via `msg` (the two variants use different paraglide keys).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi, type Permissions } from '$lib/api/admin';
  import { errText } from '$lib/utils/errText';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input/index.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import Select from '$lib/components/form/Select.svelte';

  /** Die Beschriftungen beider Varianten; Werte sind paraglide-Keys
   *  (`m.admin_stream_limits_*` bzw. `m.admin_normal_stream_limits_*`). */
  export type StreamLimitMsgs = {
    title: () => string;
    description: () => string;
    error: (p: { error: string }) => string;
    bitrateLabel: () => string;
    bitrateHint: () => string;
    bitrateMinAria: () => string;
    bitrateMaxAria: () => string;
    to: () => string;
    mbitUnit: () => string;
    fpsLabel: () => string;
    fpsHint: () => string;
    fpsMinAria: () => string;
    fpsMaxAria: () => string;
    fpsUnit: () => string;
    resolutionLabel: () => string;
    resolutionHint: () => string;
    resolutionAria: () => string;
    save: () => string;
    saving: () => string;
    loading: () => string;
    toastBitrateInvalid: () => string;
    toastBitrateInvalidDesc: () => string;
    toastBitrateTitle: () => string;
    toastMinOverMax: () => string;
    toastFpsInvalid: () => string;
    toastFpsInvalidDesc: () => string;
    toastFpsTitle: () => string;
    toastSaved: () => string;
    toastSaveFailed: () => string;
  };

  let {
    prefix,
    resolutions,
    nativeValue,
    nativeLabel,
    msg,
    testId
  }: {
    /** Feldpräfix auf dem Permissions-Objekt (`hq_` / `ns_`) — auch Basis der data-testids. */
    prefix: 'hq' | 'ns';
    resolutions: readonly string[];
    /** Wert in `resolutions`, der „kein Deckel" bedeutet ('Native' / 'native'). */
    nativeValue: string;
    nativeLabel: () => string;
    msg: StreamLimitMsgs;
    testId: string;
  } = $props();

  // Permissions-Felder per Präfix adressieren — die Typen haben keine
  // Index-Signatur, daher der enge Cast auf die fünf bekannten Schlüssel.
  function field(name: string): keyof Permissions {
    return (`${prefix}_${name}`) as keyof Permissions;
  }

  let current = $state<Permissions | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // Working copy. Bitrate in Mbit/s for the UI; fps raw; resolution string.
  let bitrateMinMbit = $state<number | ''>('');
  let bitrateMaxMbit = $state<number | ''>('');
  let fpsMin = $state<number | ''>('');
  let fpsMax = $state<number | ''>('');
  let resolutionMax = $state('');

  function populate(p: Permissions): void {
    bitrateMinMbit = p[field('bitrate_min_kbps')] as number / 1000;
    bitrateMaxMbit = p[field('bitrate_max_kbps')] as number / 1000;
    fpsMin = p[field('fps_min')] as number;
    fpsMax = p[field('fps_max')] as number;
    resolutionMax = p[field('resolution_max')] as string;
  }

  onMount(async () => {
    try {
      current = await adminApi.getPermissions();
      populate(current);
    } catch (e) {
      error = errText(e);
    }
  });

  const dirty = $derived(
    !!current &&
      (Math.round(Number(bitrateMinMbit) * 1000) !== (current[field('bitrate_min_kbps')] as number) ||
        Math.round(Number(bitrateMaxMbit) * 1000) !== (current[field('bitrate_max_kbps')] as number) ||
        Number(fpsMin) !== (current[field('fps_min')] as number) ||
        Number(fpsMax) !== (current[field('fps_max')] as number) ||
        resolutionMax !== current[field('resolution_max')])
  );

  async function save() {
    if (!current || busy) return;
    const bMin = Math.round(Number(bitrateMinMbit) * 1000);
    const bMax = Math.round(Number(bitrateMaxMbit) * 1000);
    const fMin = Number(fpsMin);
    const fMax = Number(fpsMax);

    // Mirror the backend bounds so the toast explains the problem before the
    // round-trip. Bitrate 1–100 Mbit/s (1000–100000 kbps), FPS 1–1000
    // (für beide Wertesätze gleich — auch der Screen-Share-FPS-Deckel ist 1000).
    if (![bMin, bMax].every((v) => Number.isFinite(v) && v >= 1000 && v <= 100000)) {
      toast.error(msg.toastBitrateInvalid(), { description: msg.toastBitrateInvalidDesc() });
      return;
    }
    if (bMin > bMax) {
      toast.error(msg.toastBitrateTitle(), { description: msg.toastMinOverMax() });
      return;
    }
    if (![fMin, fMax].every((v) => Number.isInteger(v) && v >= 1 && v <= 1000)) {
      toast.error(msg.toastFpsInvalid(), { description: msg.toastFpsInvalidDesc() });
      return;
    }
    if (fMin > fMax) {
      toast.error(msg.toastFpsTitle(), { description: msg.toastMinOverMax() });
      return;
    }

    busy = true;
    try {
      current = await adminApi.patchPermissions({
        [field('bitrate_min_kbps')]: bMin,
        [field('bitrate_max_kbps')]: bMax,
        [field('fps_min')]: fMin,
        [field('fps_max')]: fMax,
        [field('resolution_max')]: resolutionMax
      } as Partial<Permissions>);
      populate(current);
      toast.success(msg.toastSaved());
    } catch (e) {
      toast.error(msg.toastSaveFailed(), {
        description: errText(e)
      });
    } finally {
      busy = false;
    }
  }

  function resLabel(r: string): string {
    return r === nativeValue ? nativeLabel() : r;
  }

  // `$derived`, weil `resLabel()` ein m.* ruft — als const bliebe die
  // Beschriftung beim Sprachwechsel stehen (dieselbe Regel wie in
  // SettingsStandplatz: label() erst hier aufrufen).
  const resOptionen = $derived(resolutions.map((r) => ({ value: r, label: resLabel(r) })));
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid={testId}>
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{msg.title()}</h2>
    <p class="text-text-muted text-xs mt-0.5">
      {msg.description()}
    </p>
  </div>

  {#if error}
    <FieldError message={msg.error({ error: error ?? '' })} />
  {:else if current}
    <div class="flex flex-col gap-2">
      <!-- Bitrate -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{msg.bitrateLabel()}</div>
          <div class="text-text-muted text-xs mt-0.5">{msg.bitrateHint()}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Input
            type="number" min="1" max="100" step="any"
            bind:value={bitrateMinMbit}
            class="w-20 text-right tabular-nums"
            data-testid="{prefix}-bitrate-min" aria-label={msg.bitrateMinAria()}
          />
          <span class="text-text-muted text-xs">{msg.to()}</span>
          <Input
            type="number" min="1" max="100" step="any"
            bind:value={bitrateMaxMbit}
            class="w-20 text-right tabular-nums"
            data-testid="{prefix}-bitrate-max" aria-label={msg.bitrateMaxAria()}
          />
          <span class="text-text-muted text-xs">{msg.mbitUnit()}</span>
        </div>
      </div>

      <!-- FPS -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{msg.fpsLabel()}</div>
          <div class="text-text-muted text-xs mt-0.5">{msg.fpsHint()}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Input
            type="number" min="1" max="1000" step="1"
            bind:value={fpsMin}
            class="w-20 text-right tabular-nums"
            data-testid="{prefix}-fps-min" aria-label={msg.fpsMinAria()}
          />
          <span class="text-text-muted text-xs">{msg.to()}</span>
          <Input
            type="number" min="1" max="1000" step="1"
            bind:value={fpsMax}
            class="w-20 text-right tabular-nums"
            data-testid="{prefix}-fps-max" aria-label={msg.fpsMaxAria()}
          />
          <span class="text-text-muted text-xs">{msg.fpsUnit()}</span>
        </div>
      </div>

      <!-- Resolution ceiling -->
      <div class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">{msg.resolutionLabel()}</div>
          <div class="text-text-muted text-xs mt-0.5">
            {msg.resolutionHint()}
          </div>
        </div>
        <Select
          class="w-44 shrink-0"
          value={resolutionMax}
          options={resOptionen}
          onchange={(v) => (resolutionMax = v)}
          data-testid="{prefix}-resolution-max"
          aria-label={msg.resolutionAria()}
        />
      </div>

      <div class="mt-1 flex justify-end">
        <Button
          size="xs"
          disabled={busy || !dirty}
          onclick={save}
          data-testid="{prefix}-limits-save"
        >
          {busy ? msg.saving() : msg.save()}
        </Button>
      </div>
    </div>
  {:else}
    <LoadingState label={msg.loading()} />
  {/if}
</section>
