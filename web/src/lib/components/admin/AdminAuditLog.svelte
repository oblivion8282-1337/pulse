<!--
  Merged audit log — auth-svc and chat-gateway each emit their own slice,
  the client tags by source and merges by `created_at` desc.

  Each row renders a one-line summary (`actor → action on target`).
  Detail-payload is expandable via the chevron. ``from/to`` pairs render
  pretty for the common case; unknown shapes fall back to JSON-pretty.
-->
<script lang="ts">
import { errText } from '$lib/utils/errText';
  import { formatTimestamp } from '$lib/utils/formatTimestamp';
  import { onMount } from 'svelte';
  import { adminApi, type AuditLogEntry } from '$lib/api/admin';
  import { userCache, fmtUser } from '$lib/stores/users.svelte';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import RefreshCcwIcon from '@lucide/svelte/icons/refresh-ccw';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  // Self-Host (isCloud=false): nur der chat-gateway-Audit von der Instanz; der
  // auth-svc-Audit liegt auf der Cloud und ist hier nicht zugänglich/leer.
  let { isCloud = true }: { isCloud?: boolean } = $props();

  let entries = $state<AuditLogEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let expanded = $state<Set<string>>(new Set());

  async function load() {
    loading = true;
    try {
      const merged = await adminApi.mergedAuditLog(50, isCloud);
      entries = merged;
      // Prefetch involved usernames so we can render "@alice" not "47683…".
      for (const e of merged) {
        userCache.queue(e.actor_id);
        if (e.target_id) userCache.queue(e.target_id);
      }
    } catch (e) {
      error = errText(e);
    } finally {
      loading = false;
    }
  }

  function toggle(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }


  function fmtAction(e: AuditLogEntry): string {
    if (e.action === 'user.patch') {
      const fields = Object.keys(e.payload);
      return m.admin_audit_log_action_user_patch({ fields: fields.join(', ') });
    }
    if (e.action === 'settings.patch') return m.admin_audit_log_action_settings_patch();
    if (e.action === 'dm_limits.patch') return m.admin_audit_log_action_dm_limits_patch();
    return e.action;
  }


  onMount(load);
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-audit-log">
  <div class="mb-4 flex items-center justify-between">
    <div>
      <h2 class="text-text-bright text-base font-semibold">{m.admin_audit_log_title()}</h2>
      <p class="text-text-muted text-xs mt-0.5">
        {m.admin_audit_log_subtitle()}
      </p>
    </div>
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={load}
      aria-label={m.admin_audit_log_refresh_label()}
      disabled={loading}
      data-testid="admin-audit-refresh"
    >
      <RefreshCcwIcon class="size-4 {loading ? 'animate-spin' : ''}" />
    </Button>
  </div>

  {#if error}
    <FieldError message={m.admin_audit_log_error({ message: error ?? '' })} />
  {:else if loading && entries.length === 0}
    <LoadingState label={m.admin_audit_log_loading()} />
  {:else if entries.length === 0}
    <EmptyState message={m.admin_audit_log_empty()} />
  {:else}
    <ul class="divide-border bg-bg-hover/30 divide-y rounded-xl border border-border">
      {#each entries as e (e.source + e.id)}
        {@const isOpen = expanded.has(e.source + e.id)}
        <li class="p-3" data-testid="audit-entry">
          <button
            type="button"
            class="flex w-full items-start gap-3 text-left"
            onclick={() => toggle(e.source + e.id)}
          >
            <div class="flex-1 min-w-0">
              <div class="text-text-bright flex flex-wrap items-center gap-2 text-sm">
                <span class="font-medium">{fmtUser(e.actor_id)}</span>
                <span class="text-text-muted">{fmtAction(e)}</span>
                {#if e.target_id}
                  <span class="text-text-muted">{m.admin_audit_log_on()}</span>
                  <span class="font-medium">{fmtUser(e.target_id)}</span>
                {/if}
              </div>
              <div class="text-text-muted mt-0.5 text-xs">
                {formatTimestamp(e.created_at)} · {e.source}-svc
              </div>
            </div>
            <ChevronDownIcon
              class="text-text-muted size-4 shrink-0 transition-transform {isOpen
                ? 'rotate-180'
                : ''}"
            />
          </button>

          {#if isOpen}
            <pre
              class="bg-bg-panel text-text-base mt-2 max-h-48 overflow-auto rounded-md p-3 text-xs"
              data-testid="audit-payload"
            >{JSON.stringify(e.payload, null, 2)}</pre>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
