<!--
  Instanzweiter Voice-Bitrate-Deckel. Schreibt voice_bitrate_max_kbps auf dem
  chat_settings-Singleton via PATCH /admin/permissions; Clients übernehmen ihn
  live (capabilities-Store): der Slider unter "Sprache und Video" endet dort,
  und der Publish-Pfad klemmt pro Kanal.

  Pro-Community-Overrides (AdminCommunityLimits, "Boost") dürfen HÖHER liegen —
  dieser Wert ist der Default für alle Communitys ohne Override. Best-effort
  wie alle Qualitäts-Caps (client-enforced), gleiche Ehrlichkeits-Notiz wie
  bei den Stream-Limits.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { adminApi, type Permissions } from '$lib/api/admin';
  import { m } from '$lib/paraglide/messages.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let current = $state<Permissions | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let maxKbps = $state<number | ''>('');

  onMount(async () => {
    try {
      current = await adminApi.getPermissions();
      maxKbps = current.voice_bitrate_max_kbps;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  const dirty = $derived(!!current && Number(maxKbps) !== current.voice_bitrate_max_kbps);

  async function save() {
    if (!current || busy) return;
    const v = Number(maxKbps);
    // Backend-Grenzen gespiegelt (16–512), damit der Toast das Problem vor dem
    // Round-Trip erklärt.
    if (!Number.isInteger(v) || v < 16 || v > 512) {
      toast.error(m.admin_voice_limits_toast_invalid(), {
        description: m.admin_voice_limits_toast_invalid_desc()
      });
      return;
    }
    busy = true;
    try {
      current = await adminApi.patchPermissions({ voice_bitrate_max_kbps: v });
      maxKbps = current.voice_bitrate_max_kbps;
      toast.success(m.admin_voice_limits_toast_saved());
    } catch (e) {
      toast.error(m.admin_voice_limits_toast_save_failed(), {
        description: e instanceof Error ? e.message : String(e)
      });
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-voice-limits">
  <div class="mb-4">
    <h2 class="text-text-bright text-base font-semibold">{m.admin_voice_limits_title()}</h2>
    <p class="text-text-muted mt-0.5 text-xs">{m.admin_voice_limits_description()}</p>
  </div>

  {#if error}
    <FieldError message={m.admin_voice_limits_error({ error: error ?? '' })} />
  {:else if current}
    <div class="flex flex-col gap-2">
      <div
        class="flex flex-col gap-2 rounded-xl border border-border bg-bg-hover/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
      >
        <div class="min-w-0 flex-1">
          <div class="text-text-bright text-sm font-medium">
            {m.admin_voice_limits_bitrate_label()}
          </div>
          <div class="text-text-muted mt-0.5 text-xs">{m.admin_voice_limits_bitrate_hint()}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            type="number"
            min="16"
            max="512"
            step="8"
            bind:value={maxKbps}
            class="w-24 rounded-md border border-border bg-bg-input px-2 py-1 text-right text-sm tabular-nums text-text-bright focus:border-primary focus:outline-none"
            data-testid="voice-bitrate-max"
            aria-label={m.admin_voice_limits_bitrate_label()}
          />
          <span class="text-text-muted text-xs">{m.admin_voice_limits_kbps_unit()}</span>
        </div>
      </div>

      <div class="mt-1 flex justify-end">
        <button
          type="button"
          disabled={busy || !dirty}
          onclick={save}
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          data-testid="voice-limits-save"
        >
          {busy ? m.admin_stream_limits_saving() : m.admin_stream_limits_save()}
        </button>
      </div>
    </div>
  {:else}
    <LoadingState label={m.admin_stream_limits_loading()} />
  {/if}
</section>
