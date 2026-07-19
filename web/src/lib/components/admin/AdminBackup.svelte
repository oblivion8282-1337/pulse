<!--
  Read-only backup status card. Hits GET /admin/backup-status on mount
  and surfaces four states: not-configured (sidecar not deployed),
  no-run-yet (configured but marker missing), healthy (recent run),
  stale (>36 h since last successful run — matches compose healthcheck).

  There is no "trigger backup" / "restore" UI here by design. Restore
  is destructive; trigger would need the sidecar's docker socket exposed
  to auth-svc. Both stay in SSH + `docker compose exec` land — see
  infra/prod/backup/restore.md.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { adminApi, type BackupStatus } from '$lib/api/admin';
  import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
  import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
  import ShieldOffIcon from '@lucide/svelte/icons/shield-off';
  import ClockIcon from '@lucide/svelte/icons/clock';
  import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
  import { m } from '$lib/paraglide/messages.js';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let data = $state<BackupStatus | null>(null);
  let error = $state<string | null>(null);
  let refreshing = $state(false);

  async function load() {
    refreshing = true;
    error = null;
    try {
      data = await adminApi.getBackupStatus();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      refreshing = false;
    }
  }

  onMount(load);

  function fmtAge(seconds: number): string {
    if (seconds < 60) return m.admin_backup_age_just_now();
    if (seconds < 3600) return m.admin_backup_age_minutes({ minutes: Math.floor(seconds / 60) });
    if (seconds < 86400) return m.admin_backup_age_hours({ hours: Math.floor(seconds / 3600) });
    const days = Math.floor(seconds / 86400);
    return days === 1
      ? m.admin_backup_age_one_day()
      : m.admin_backup_age_days({ days });
  }

  function fmtTimestamp(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  }

  const view = $derived.by(() => {
    if (!data) return null;
    if (!data.configured) return 'not-configured';
    if (data.last_backup_at === null) return 'no-run-yet';
    return data.healthy ? 'healthy' : 'stale';
  });
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-backup">
  <div class="mb-4 flex items-start justify-between gap-3">
    <div>
      <h2 class="text-text-bright text-base font-semibold">{m.admin_backup_heading()}</h2>
      <p class="text-text-muted text-xs mt-0.5">
        {m.admin_backup_description()}
      </p>
    </div>
    <button
      type="button"
      onclick={load}
      disabled={refreshing}
      class="text-text-muted hover:text-text-bright rounded-lg p-1.5 hover:bg-bg-hover disabled:opacity-50"
      aria-label={m.admin_backup_refresh_label()}
      data-testid="admin-backup-refresh"
    >
      <RefreshIcon class="size-4 {refreshing ? 'animate-spin' : ''}" />
    </button>
  </div>

  {#if error}
    <FieldError message={m.admin_backup_error({ message: error! })} testId="admin-backup-error" />
  {:else if !data}
    <LoadingState label={m.admin_backup_loading()} />
  {:else if view === 'not-configured'}
    <div
      class="flex items-start gap-3 rounded-xl bg-bg-hover/50 p-4"
      data-testid="admin-backup-state-not-configured"
    >
      <ShieldOffIcon class="text-text-muted size-5 shrink-0 mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-text-bright text-sm font-medium">{m.admin_backup_not_configured_title()}</span>
        <span class="text-text-muted text-xs leading-relaxed">
          {m.admin_backup_not_configured_body_pre()}<code
            class="bg-bg-panel px-1 py-0.5 rounded text-[11px]"
            >infra/prod/DEPLOY.md</code
          >{m.admin_backup_not_configured_body_post()}
        </span>
      </div>
    </div>
  {:else if view === 'no-run-yet'}
    <div
      class="flex items-start gap-3 rounded-xl bg-bg-hover/50 p-4"
      data-testid="admin-backup-state-no-run"
    >
      <ClockIcon class="text-warning size-5 shrink-0 mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-text-bright text-sm font-medium">{m.admin_backup_no_run_title()}</span>
        <span class="text-text-muted text-xs leading-relaxed">
          {m.admin_backup_no_run_body()}
        </span>
      </div>
    </div>
  {:else if view === 'healthy'}
    <div
      class="flex items-start gap-3 rounded-xl bg-success/10 p-4"
      data-testid="admin-backup-state-healthy"
    >
      <ShieldCheckIcon class="text-success size-5 shrink-0 mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-success text-sm font-medium">{m.admin_backup_healthy_title()}</span>
        <span class="text-text-muted text-xs">
          {m.admin_backup_last_success()} {fmtAge(data!.age_seconds!)} ·
          <span class="text-text-base">{fmtTimestamp(data!.last_backup_at!)}</span>
        </span>
      </div>
    </div>
  {:else if view === 'stale'}
    <div
      class="flex items-start gap-3 rounded-xl bg-destructive/10 p-4"
      data-testid="admin-backup-state-stale"
    >
      <ShieldAlertIcon class="text-destructive size-5 shrink-0 mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-destructive text-sm font-medium">
          {m.admin_backup_stale_title({ hours: Math.round(data!.stale_threshold_seconds / 3600) })}
        </span>
        <span class="text-text-muted text-xs">
          {m.admin_backup_last_success()} {fmtAge(data!.age_seconds!)} ·
          <span class="text-text-base">{fmtTimestamp(data!.last_backup_at!)}</span>.
          <code class="bg-bg-panel px-1 py-0.5 rounded text-[11px]">docker logs pulse_backup</code>
          {m.admin_backup_stale_check_logs()}
        </span>
      </div>
    </div>
  {/if}

  <p class="text-text-muted text-[11px] leading-relaxed mt-3">
    {m.admin_backup_footer_pre()}<code
      class="bg-bg-panel px-1 py-0.5 rounded">docker compose exec backup …</code
    >{m.admin_backup_footer_mid()}<code class="bg-bg-panel px-1 py-0.5 rounded"
      >infra/prod/backup/restore.md</code
    >{m.admin_backup_footer_post()}
  </p>
</section>
