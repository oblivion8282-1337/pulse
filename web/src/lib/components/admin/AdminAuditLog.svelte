<!--
  Merged audit log — auth-svc and chat-gateway each emit their own slice,
  the client tags by source and merges by `created_at` desc.

  Each row renders a one-line summary (`actor → action on target`).
  Detail-payload is expandable via the chevron. ``from/to`` pairs render
  pretty for the common case; unknown shapes fall back to JSON-pretty.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { adminApi, type AuditLogEntry } from '$lib/api/admin';
  import { userCache } from '$lib/stores/users.svelte';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import RefreshCcwIcon from '@lucide/svelte/icons/refresh-ccw';

  let entries = $state<AuditLogEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let expanded = $state<Set<string>>(new Set());

  async function load() {
    loading = true;
    try {
      const merged = await adminApi.mergedAuditLog(50);
      entries = merged;
      // Prefetch involved usernames so we can render "@alice" not "47683…".
      for (const e of merged) {
        userCache.queue(e.actor_id);
        if (e.target_id) userCache.queue(e.target_id);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function fmtUser(id: string | null): string {
    if (!id) return '—';
    const u = userCache.get(id);
    return u ? `@${u.display_name ?? u.username}` : `…${id.slice(-6)}`;
  }

  function fmtAction(e: AuditLogEntry): string {
    if (e.action === 'user.patch') {
      const fields = Object.keys(e.payload);
      return `User-Änderung (${fields.join(', ')})`;
    }
    if (e.action === 'settings.patch') return 'Registrierung geändert';
    if (e.action === 'dm_limits.patch') return 'DM-Limits geändert';
    return e.action;
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

  onMount(load);
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-audit-log">
  <div class="mb-4 flex items-center justify-between">
    <div>
      <h2 class="text-text-bright text-base font-semibold">Audit-Log</h2>
      <p class="text-text-muted text-xs mt-0.5">
        Admin-Aktionen aus auth-svc und chat-gateway, neueste zuerst.
      </p>
    </div>
    <button
      type="button"
      onclick={load}
      class="text-text-muted hover:text-text-bright hover:bg-bg-hover rounded-md p-1.5"
      aria-label="Aktualisieren"
      disabled={loading}
      data-testid="admin-audit-refresh"
    >
      <RefreshCcwIcon class="size-4 {loading ? 'animate-spin' : ''}" />
    </button>
  </div>

  {#if error}
    <p class="text-red-400 text-sm">Fehler: {error}</p>
  {:else if loading && entries.length === 0}
    <div class="text-text-muted text-sm">lade…</div>
  {:else if entries.length === 0}
    <div class="text-text-muted text-sm">Noch keine Admin-Aktionen.</div>
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
                  <span class="text-text-muted">an</span>
                  <span class="font-medium">{fmtUser(e.target_id)}</span>
                {/if}
              </div>
              <div class="text-text-muted mt-0.5 text-xs">
                {fmtTime(e.created_at)} · {e.source}-svc
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
              class="bg-bg-panel text-text-base mt-2 max-h-48 overflow-auto rounded-lg p-3 text-xs"
              data-testid="audit-payload"
            >{JSON.stringify(e.payload, null, 2)}</pre>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
