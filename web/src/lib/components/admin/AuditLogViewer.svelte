<!--
  Guild-Audit-Log Viewer. Zeigt Mod-Aktionen (resolve, ban, etc.) mit
  Actor, Action, Target und Timestamp. Pagination via "Mehr laden".
  Nur sichtbar wenn MANAGE_GUILD.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { listAuditLog, type AuditLogEntry } from '$lib/api/moderation';
  import { userCache } from '$lib/stores/users.svelte';
  import RefreshCcwIcon from '@lucide/svelte/icons/refresh-ccw';
  import { m } from '$lib/paraglide/messages.js';

  let { guildId }: { guildId: string } = $props();

  let entries = $state<AuditLogEntry[]>([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let loadError = $state<string | null>(null);
  let hasMore = $state(true);
  const PAGE = 50;

  const ACTION_LABELS: Record<string, () => string> = {
    report_resolved: m.audit_log_action_report_resolved,
    report_dismissed: m.audit_log_action_report_dismissed,
    ban: m.audit_log_action_ban,
    unban: m.audit_log_action_unban,
    kick: m.audit_log_action_kick,
    message_delete: m.audit_log_action_message_delete,
    warn: m.audit_log_action_warn,
    role_change: m.audit_log_action_role_change
  };

  async function load(reset = false) {
    if (reset) {
      loading = true;
      entries = [];
      hasMore = true;
    } else {
      loadingMore = true;
    }
    loadError = null;
    try {
      const before = reset ? undefined : entries[entries.length - 1]?.created_at;
      const page = await listAuditLog(guildId, PAGE, before);
      const next = reset ? page : [...entries, ...page];
      entries = next;
      hasMore = page.length === PAGE;
      for (const e of page) {
        if (e.actor_user_id) userCache.queue(e.actor_user_id);
        if (e.target_id) userCache.queue(e.target_id);
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  onMount(() => { void load(true); });

  function fmtUser(id: string | null): string {
    if (!id) return '—';
    const u = userCache.get(id);
    return u ? `@${u.display_name ?? u.username}` : `…${id.slice(-6)}`;
  }

  function fmtAction(type: string): string {
    return ACTION_LABELS[type]?.() ?? type;
  }

  function fmtTime(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
</script>

<section class="flex flex-col gap-5" data-testid="audit-log-panel">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-text-bright text-lg font-semibold">{m.audit_log_title()}</h2>
      <p class="text-text-muted text-sm">{m.audit_log_subtitle()}</p>
    </div>
    <button
      type="button"
      onclick={() => load(true)}
      disabled={loading}
      class="text-text-muted hover:text-text-bright hover:bg-bg-hover rounded-md p-1.5"
      aria-label={m.audit_log_refresh_label()}
      data-testid="audit-log-refresh"
    >
      <RefreshCcwIcon class="size-4 {loading ? 'animate-spin' : ''}" />
    </button>
  </div>

  {#if loadError}
    <p class="text-destructive text-sm" data-testid="audit-log-error">{m.audit_log_load_error({ message: loadError! })}</p>
  {:else if loading}
    <p class="text-text-muted text-sm">{m.audit_log_loading()}</p>
  {:else if entries.length === 0}
    <p class="text-text-muted text-sm">{m.audit_log_empty()}</p>
  {:else}
    <ul class="divide-border bg-bg-hover/30 divide-y rounded-xl border border-border" data-testid="audit-log-list">
      {#each entries as e (e.id)}
        <li class="flex items-start gap-3 p-3" data-testid="audit-log-entry">
          <div class="min-w-0 flex-1">
            <div class="text-text-bright flex flex-wrap items-center gap-1.5 text-sm">
              <span class="font-medium">{fmtUser(e.actor_user_id)}</span>
              <span class="text-text-muted">{fmtAction(e.action_type)}</span>
              {#if e.target_id && e.target_kind}
                <span class="text-text-muted text-xs">
                  ({e.target_kind}: …{e.target_id.slice(-6)})
                </span>
              {/if}
            </div>
            <div class="text-text-muted mt-0.5 text-xs">{fmtTime(e.created_at)}</div>
          </div>
        </li>
      {/each}
    </ul>

    {#if hasMore}
      <button
        type="button"
        onclick={() => load(false)}
        disabled={loadingMore}
        class="bg-bg-input text-text-muted hover:bg-bg-hover self-center rounded-md px-4 py-2 text-sm transition-colors disabled:opacity-50"
        data-testid="audit-log-load-more"
      >
        {loadingMore ? m.audit_log_loading_more() : m.audit_log_load_more()}
      </button>
    {/if}
  {/if}
</section>
