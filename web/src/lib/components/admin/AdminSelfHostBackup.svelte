<!--
  Self-Host-Backup-Status (F11b). Zeigt die pg_dump-Snapshots, die der
  allinone-`backup`-Service nach /data/backups schreibt. Nur auf Self-Host
  gerendert (das +page.svelte gated mit {#if !isCloud}). Read-only.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { adminApi, type SelfHostBackupStatus } from '$lib/api/admin';
  import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let status = $state<SelfHostBackupStatus | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      status = await adminApi.selfHostBackups();
    } catch (e) {
      error = errText(e);
    } finally {
      loading = false;
    }
  });

  function fmtBytes(n: number): string {
    const mb = n / 1024 / 1024;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${(n / 1024).toFixed(0)} KB`;
  }
  function fmtTime(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-self-host-backup">
  <div class="mb-4 flex items-start gap-3">
    <DatabaseBackupIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
    <div class="min-w-0">
      <h2 class="text-text-bright text-base font-semibold">Backups</h2>
      <p class="text-text-muted text-xs mt-0.5">
        Automatische pg_dump-Snapshots dieser Instanz unter <code>/data/backups</code>.
      </p>
    </div>
  </div>

  {#if loading}
    <LoadingState label="Lade…" />
  {:else if error}
    <FieldError message="Fehler: {error}" />
  {:else if status && !status.enabled}
    <p class="text-text-muted text-sm">
      Backup ist deaktiviert oder das Verzeichnis fehlt (<code>{status.directory}</code>).
    </p>
  {:else if status}
    <div class="mb-3 flex flex-wrap gap-4 text-sm">
      <div>
        <span class="text-text-muted">Letztes Backup:</span>
        <span class="text-text-bright font-medium">
          {status.last_backup_at ? fmtTime(status.last_backup_at) : 'noch keins'}
        </span>
      </div>
      <div>
        <span class="text-text-muted">Snapshots:</span>
        <span class="text-text-bright font-medium">{status.backups.length}</span>
      </div>
      <div>
        <span class="text-text-muted">Gesamt:</span>
        <span class="text-text-bright font-medium">{fmtBytes(status.total_bytes)}</span>
      </div>
    </div>

    {#if status.backups.length > 0}
      <ul class="divide-border bg-bg-hover/30 divide-y rounded-xl border border-border">
        {#each status.backups as b (b.filename)}
          <li class="flex items-center justify-between gap-3 p-3 text-sm" data-testid="backup-entry">
            <span class="text-text-base truncate font-mono text-xs">{b.filename}</span>
            <span class="text-text-muted shrink-0 text-xs">
              {fmtTime(b.created_at)} · {fmtBytes(b.size_bytes)}
            </span>
          </li>
        {/each}
      </ul>
    {:else}
      <EmptyState message="Noch keine Snapshots — der erste läuft kurz nach dem Container-Start." />
    {/if}
  {/if}
</section>
