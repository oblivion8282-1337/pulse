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
    if (seconds < 60) return 'gerade eben';
    if (seconds < 3600) return `vor ${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `vor ${Math.floor(seconds / 3600)} h`;
    const days = Math.floor(seconds / 86400);
    return `vor ${days} ${days === 1 ? 'Tag' : 'Tagen'}`;
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
      <h2 class="text-text-bright text-base font-semibold">Backup</h2>
      <p class="text-text-muted text-xs mt-0.5">
        Verschlüsselte restic-Snapshots (Postgres, MinIO, Avatare, Server-Icons).
      </p>
    </div>
    <button
      type="button"
      onclick={load}
      disabled={refreshing}
      class="text-text-muted hover:text-text-bright rounded-lg p-1.5 hover:bg-bg-hover disabled:opacity-50"
      aria-label="Aktualisieren"
      data-testid="admin-backup-refresh"
    >
      <RefreshIcon class="size-4 {refreshing ? 'animate-spin' : ''}" />
    </button>
  </div>

  {#if error}
    <p class="text-red-400 text-sm" data-testid="admin-backup-error">Fehler: {error}</p>
  {:else if !data}
    <div class="text-text-muted text-sm">lade…</div>
  {:else if view === 'not-configured'}
    <div
      class="flex items-start gap-3 rounded-xl bg-bg-hover/50 p-4"
      data-testid="admin-backup-state-not-configured"
    >
      <ShieldOffIcon class="text-text-muted size-5 shrink-0 mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-text-bright text-sm font-medium">Backup nicht eingerichtet</span>
        <span class="text-text-muted text-xs leading-relaxed">
          Der Backup-Sidecar läuft noch nicht. Setup-Anleitung: <code
            class="bg-bg-panel px-1 py-0.5 rounded text-[11px]"
            >infra/prod/DEPLOY.md</code
          >
          → Abschnitt „Backups".
        </span>
      </div>
    </div>
  {:else if view === 'no-run-yet'}
    <div
      class="flex items-start gap-3 rounded-xl bg-bg-hover/50 p-4"
      data-testid="admin-backup-state-no-run"
    >
      <ClockIcon class="text-amber-400 size-5 shrink-0 mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-text-bright text-sm font-medium">Noch kein Backup gelaufen</span>
        <span class="text-text-muted text-xs leading-relaxed">
          Der Sidecar ist da, aber es gab noch keinen erfolgreichen Lauf. Erster Postgres-Snapshot
          läuft täglich um 04:00 UTC.
        </span>
      </div>
    </div>
  {:else if view === 'healthy'}
    <div
      class="flex items-start gap-3 rounded-xl bg-emerald-400/10 p-4"
      data-testid="admin-backup-state-healthy"
    >
      <ShieldCheckIcon class="text-emerald-400 size-5 shrink-0 mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-emerald-300 text-sm font-medium">Backups laufen</span>
        <span class="text-text-muted text-xs">
          Letzter Erfolg: {fmtAge(data!.age_seconds!)} ·
          <span class="text-text-base">{fmtTimestamp(data!.last_backup_at!)}</span>
        </span>
      </div>
    </div>
  {:else if view === 'stale'}
    <div
      class="flex items-start gap-3 rounded-xl bg-red-400/10 p-4"
      data-testid="admin-backup-state-stale"
    >
      <ShieldAlertIcon class="text-red-400 size-5 shrink-0 mt-0.5" />
      <div class="flex flex-col gap-1">
        <span class="text-red-300 text-sm font-medium">
          Backup veraltet — seit über {Math.round(data!.stale_threshold_seconds / 3600)} h kein
          erfolgreicher Lauf
        </span>
        <span class="text-text-muted text-xs">
          Letzter Erfolg: {fmtAge(data!.age_seconds!)} ·
          <span class="text-text-base">{fmtTimestamp(data!.last_backup_at!)}</span>.
          <code class="bg-bg-panel px-1 py-0.5 rounded text-[11px]">docker logs pulse_backup</code>
          checken.
        </span>
      </div>
    </div>
  {/if}

  <p class="text-text-muted text-[11px] leading-relaxed mt-3">
    Snapshots ansehen, manuelle Backups oder Restore: SSH + <code
      class="bg-bg-panel px-1 py-0.5 rounded">docker compose exec backup …</code
    >. Runbook unter <code class="bg-bg-panel px-1 py-0.5 rounded"
      >infra/prod/backup/restore.md</code
    >.
  </p>
</section>
