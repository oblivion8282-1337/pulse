<script lang="ts">
  /**
   * Quota gauge — used / total + coloured progress bar.
   * The threshold colours mirror the previous markup so nothing
   * changes for the user:
   *   - <80 %       → brand
   *   - 80 %..95 %  → chart-3 / amber
   *   - >=95 %      → destructive
   */
  import { formatBytes } from '$lib/utils/formatBytes';
  import { m as pm } from '$lib/paraglide/messages.js';
  import type { DropboxConfig } from '$lib/api/dropbox';

  type Props = {
    quota: DropboxConfig | null;
  };

  let { quota }: Props = $props();

  function pct(b: number, t: number): number {
    if (t <= 0) return 0;
    return Math.min(100, Math.round((b / t) * 100));
  }

  const fillPct = $derived(
    quota ? pct(quota.used_bytes, quota.total_quota_bytes) : 0
  );
</script>

{#if quota}
  <div class="border-b border-border/40 bg-bg-hover/30 px-5 py-3">
    <div class="flex items-center justify-between text-xs">
      <span class="text-text-dim">
        {pm.dropbox_used_of_total({
          used: formatBytes(quota.used_bytes),
          total: formatBytes(quota.total_quota_bytes)
        })}
      </span>
      <span class="font-mono tabular-nums text-text-bright">
        {fillPct} %
      </span>
    </div>
    <div
      class="mt-2 h-2 overflow-hidden rounded-full bg-bg-hover"
      role="progressbar"
      aria-valuenow={fillPct}
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        class="h-full rounded-full transition-all"
        style="width: {fillPct}%; background: {fillPct >= 95
          ? 'var(--destructive)'
          : fillPct >= 80
            ? 'var(--chart-3, #f59e0b)'
            : 'var(--brand)'}"
        data-testid="dropbox-quota-fill"
      ></div>
    </div>
  </div>
{/if}
